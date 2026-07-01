// vision-bg-remove — native macOS background removal helper for Cutout.app
//
// Uses Apple's Vision framework (VNGenerateForegroundInstanceMaskRequest — the
// same subject-lifting model behind macOS's "Copy Subject") to isolate the
// foreground of an image and write a transparent PNG. Runs fully offline with
// no bundled ML model.
//
// Subcommands:
//   vision-bg-remove remove <input> <output>          Remove background → transparent PNG
//   vision-bg-remove topng  <input> <output> [maxDim] Decode any format → PNG (optionally downscaled)
//
// Exit codes:
//   0  success
//   2  usage error
//   3  no clear foreground subject detected (caller should surface this)
//   4  could not decode the input image
//   5  Vision request failed
//   6  could not write the output
//
// Errors are written as a single line to stderr so the Rust caller can relay them.

import Foundation
import CoreImage
import Vision

// MARK: - Small helpers

func die(_ message: String, code: Int32) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!
// A single shared context. Using the GPU by default; Vision itself uses the
// Neural Engine / GPU where available.
let ciContext = CIContext(options: [.cacheIntermediates: false])

/// Load an image from disk with its EXIF orientation already baked in, so the
/// pixels are upright. Returns nil if the file cannot be decoded.
func loadUprightImage(_ url: URL) -> CIImage? {
    return CIImage(contentsOf: url, options: [.applyOrientationProperty: true])
}

/// Encode a CIImage to a PNG file (RGBA, sRGB), preserving alpha.
func writePNG(_ image: CIImage, to url: URL) throws {
    // pngRepresentation needs a non-empty, finite extent.
    let target = image.cropped(to: image.extent.isInfinite ? CGRect(x: 0, y: 0, width: 1, height: 1) : image.extent)
    guard let data = ciContext.pngRepresentation(of: target, format: .RGBA8, colorSpace: sRGB) else {
        throw NSError(domain: "cutout", code: 6, userInfo: [NSLocalizedDescriptionKey: "PNG encoding failed"])
    }
    try data.write(to: url, options: .atomic)
}

/// Scale a CIImage so its longest side is at most `maxDim` (no upscaling).
func downscaled(_ image: CIImage, maxDim: CGFloat) -> CIImage {
    let w = image.extent.width, h = image.extent.height
    let longest = max(w, h)
    guard longest > maxDim, longest > 0 else { return image }
    let s = maxDim / longest
    return image.transformed(by: CGAffineTransform(scaleX: s, y: s))
}

// MARK: - Commands

func runRemove(input: String, output: String) {
    let inURL = URL(fileURLWithPath: input)
    guard FileManager.default.fileExists(atPath: input) else {
        die("input file not found: \(input)", code: 2)
    }
    guard let image = loadUprightImage(inURL) else {
        die("could not decode image (unsupported or corrupt file)", code: 4)
    }

    let handler = VNImageRequestHandler(ciImage: image, options: [:])
    let request = VNGenerateForegroundInstanceMaskRequest()

    do {
        try handler.perform([request])
    } catch {
        die("vision request failed: \(error.localizedDescription)", code: 5)
    }

    guard let observation = request.results?.first else {
        die("no clear subject detected in the image", code: 3)
    }
    let instances = observation.allInstances
    guard !instances.isEmpty else {
        die("no clear subject detected in the image", code: 3)
    }

    // Generate a soft, anti-aliased mask scaled to the source resolution.
    let maskBuffer: CVPixelBuffer
    do {
        maskBuffer = try observation.generateScaledMaskForImage(forInstances: instances, from: handler)
    } catch {
        die("failed to generate mask: \(error.localizedDescription)", code: 5)
    }

    var mask = CIImage(cvPixelBuffer: maskBuffer)

    // Align the mask exactly to the source extent (guards against any
    // resolution / origin mismatch between the mask buffer and the image).
    if mask.extent.width > 0 && mask.extent.height > 0 {
        let sx = image.extent.width / mask.extent.width
        let sy = image.extent.height / mask.extent.height
        if abs(sx - 1) > 0.001 || abs(sy - 1) > 0.001 {
            mask = mask.transformed(by: CGAffineTransform(scaleX: sx, y: sy))
        }
        mask = mask.transformed(by: CGAffineTransform(
            translationX: image.extent.origin.x - mask.extent.origin.x,
            y: image.extent.origin.y - mask.extent.origin.y))
    }

    // Composite the source over a fully transparent background using the mask
    // as the alpha channel → subject kept, background cleared.
    guard let blend = CIFilter(name: "CIBlendWithMask", parameters: [
        kCIInputImageKey: image,
        kCIInputBackgroundImageKey: CIImage.empty(),
        kCIInputMaskImageKey: mask,
    ]), let composited = blend.outputImage else {
        die("compositing failed", code: 5)
    }

    let result = composited.cropped(to: image.extent)
    do {
        try writePNG(result, to: URL(fileURLWithPath: output))
    } catch {
        die("failed to write output: \(error.localizedDescription)", code: 6)
    }
}

func runToPNG(input: String, output: String, maxDim: CGFloat?) {
    let inURL = URL(fileURLWithPath: input)
    guard FileManager.default.fileExists(atPath: input) else {
        die("input file not found: \(input)", code: 2)
    }
    guard var image = loadUprightImage(inURL) else {
        die("could not decode image (unsupported or corrupt file)", code: 4)
    }
    // Normalize origin to (0,0).
    image = image.transformed(by: CGAffineTransform(
        translationX: -image.extent.origin.x, y: -image.extent.origin.y))
    if let maxDim = maxDim {
        image = downscaled(image, maxDim: maxDim)
    }
    do {
        try writePNG(image, to: URL(fileURLWithPath: output))
    } catch {
        die("failed to write output: \(error.localizedDescription)", code: 6)
    }
}

// MARK: - Entry point

let args = CommandLine.arguments
guard args.count >= 2 else {
    die("usage: vision-bg-remove <remove|topng> <input> <output> [maxDim]", code: 2)
}

switch args[1] {
case "remove":
    guard args.count >= 4 else { die("usage: vision-bg-remove remove <input> <output>", code: 2) }
    runRemove(input: args[2], output: args[3])
case "topng":
    guard args.count >= 4 else { die("usage: vision-bg-remove topng <input> <output> [maxDim]", code: 2) }
    let maxDim = args.count >= 5 ? Double(args[4]).map { CGFloat($0) } : nil
    runToPNG(input: args[2], output: args[3], maxDim: maxDim)
default:
    die("unknown command '\(args[1])' (expected 'remove' or 'topng')", code: 2)
}
