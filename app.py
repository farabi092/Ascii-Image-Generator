"""
ASCII Art Studio - Flask backend.

Flow: browser POSTs an image + settings -> we decode it in memory ->
flatten transparency -> resize -> grayscale -> map brightness to characters.
We return the text AND the colour of every character (as base64 RGB bytes),
so the browser can draw coloured art, recolour it instantly, and export a PNG
without asking the server again. Nothing is written to disk or a database.
"""
import base64
import io
import os

from flask import Flask, jsonify, render_template, request
from PIL import Image, ImageOps, UnidentifiedImageError
from werkzeug.exceptions import HTTPException

# On Vercel, static files must live in public/ (served by their CDN; Flask's own
# static handling is ignored there). Pointing Flask at the same folder keeps
# local development identical to production: both serve /static/... from public/static.
app = Flask(__name__, static_folder="public/static", static_url_path="/static")

# ---------------------------------------------------------------- config ----
# Vercel Functions reject request bodies over 4.5 MB, so we cap at 4 MB (leaving room for
# form fields). The browser shrinks big phone photos before uploading to stay under this.
MAX_UPLOAD_BYTES = 4 * 1024 * 1024
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES  # Flask answers bigger bodies with 413

ALLOWED_MIME = {"image/png", "image/jpeg", "image/webp"}
ALLOWED_FORMATS = {"PNG", "JPEG", "WEBP"}      # what Pillow actually detects

MIN_WIDTH, MAX_WIDTH, DEFAULT_WIDTH = 50, 300, 140   # more columns = more detail
CHAR_ASPECT = 0.55   # a monospace cell is ~1/0.55 times taller than it is wide

Image.MAX_IMAGE_PIXELS = 25_000_000   # guard against "decompression bombs"

# Character sets, ordered from DENSEST (most ink) to SPARSEST.
CHARSETS = {
    "minimal": "@%#*+=-:. ",
    "detailed": "$@B%8&WM#*oahkbdpqwmZO0QLCJUYXzcvunxrjft/\\|()1{}[]?-_+~<>i!lI;:,\"^`'. ",
}


class ImageError(Exception):
    """A user-facing problem (bad file, wrong type...). Carries an HTTP status."""

    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


# ------------------------------------------------------- processing steps ----
def load_image(file_storage):
    """Step 1: read the upload into memory and decode it safely."""
    if file_storage.mimetype not in ALLOWED_MIME:
        raise ImageError("Unsupported file type. Please upload a PNG, JPG or WEBP.", 415)

    data = file_storage.read()
    if not data:
        raise ImageError("The uploaded file is empty.")

    try:
        Image.open(io.BytesIO(data)).verify()        # integrity check (consumes the image)
        image = Image.open(io.BytesIO(data))         # ...so open it again for real use
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, SyntaxError):
        raise ImageError("That file isn't a valid or supported image.", 415)

    if image.format not in ALLOWED_FORMATS:          # don't trust the browser's MIME type alone
        raise ImageError("Unsupported image format. Use PNG, JPG or WEBP.", 415)

    return ImageOps.exif_transpose(image)            # respect phone-camera rotation


def flatten_alpha(image, invert):
    """Step 2: composite transparency onto a solid colour.

    Black for dark-screen mode, white when reversed, so transparent areas
    become blank space instead of random characters.
    """
    image = image.convert("RGBA")
    bg = (255, 255, 255, 255) if invert else (0, 0, 0, 255)
    return Image.alpha_composite(Image.new("RGBA", image.size, bg), image).convert("RGB")


def resize_image(image, new_width):
    """Step 3: resize to `new_width` columns, correcting for character shape."""
    width, height = image.size
    new_height = max(1, round(new_width * (height / width) * CHAR_ASPECT))
    return image.resize((new_width, new_height), Image.Resampling.LANCZOS)


def to_grayscale(image, auto_contrast):
    """Step 4: collapse colour to brightness; optionally stretch the tones.

    Auto-contrast spreads the histogram so flat photos use the whole character
    ramp, which is what makes the result look detailed.
    """
    gray = image.convert("L")
    return ImageOps.autocontrast(gray, cutoff=1) if auto_contrast else gray


def build_lookup(charset_name, invert):
    """Precompute a 256-entry table: brightness value -> character."""
    ramp = CHARSETS[charset_name]            # dense -> sparse
    # Default targets a DARK screen: bright pixels get dense (visible) glyphs.
    # Reversed targets a LIGHT screen: dark pixels get dense glyphs.
    chars = ramp if invert else ramp[::-1]
    last = len(chars) - 1
    return [chars[round(v * last / 255)] for v in range(256)]


def pixels_to_ascii(gray_image, lookup):
    """Step 5: map each pixel to a character and join rows with newlines."""
    width = gray_image.width
    text = "".join(lookup[b] for b in gray_image.tobytes())   # one byte per pixel in "L" mode
    return "\n".join(text[i:i + width] for i in range(0, len(text), width))


def image_to_ascii(file_storage, width, charset, invert, auto_contrast):
    """Run the whole pipeline. Returns text, per-character colours and size."""
    image = flatten_alpha(load_image(file_storage), invert)
    image = resize_image(image, width)               # still RGB: this gives each cell its colour
    gray = to_grayscale(image, auto_contrast)
    art = pixels_to_ascii(gray, build_lookup(charset, invert))
    # 3 bytes (R,G,B) per character, row by row, base64-encoded for JSON transport
    colors = base64.b64encode(image.tobytes()).decode("ascii")
    return art, colors, image.width, image.height


# ----------------------------------------------------------- param parsing ----
def as_bool(value, default):
    if value is None:
        return default
    return str(value).lower() in {"1", "true", "on"}


def parse_params(form):
    """Validate/clamp user settings so odd values can't break anything."""
    try:
        width = int(form.get("width", DEFAULT_WIDTH))
    except (TypeError, ValueError):
        raise ImageError("Width must be a number.")
    width = max(MIN_WIDTH, min(MAX_WIDTH, width))

    charset = form.get("charset", "detailed")
    if charset not in CHARSETS:
        raise ImageError("Unknown character set.")

    return width, charset, as_bool(form.get("invert"), False), as_bool(form.get("contrast"), True)


# ----------------------------------------------------------------- routes ----
@app.route("/")
def index():
    return render_template(
        "index.html", min_width=MIN_WIDTH, max_width=MAX_WIDTH, default_width=DEFAULT_WIDTH
    )


@app.route("/convert", methods=["POST"])
def convert():
    try:
        file = request.files.get("file")
        if file is None or file.filename == "":
            raise ImageError("No image was uploaded.")
        width, charset, invert, contrast = parse_params(request.form)
        art, colors, cols, rows = image_to_ascii(file, width, charset, invert, contrast)
        return jsonify(ascii=art, colors=colors, cols=cols, rows=rows)
    except ImageError as err:
        return jsonify(error=err.message), err.status
    except HTTPException:
        raise  # let Flask's own handlers (like the 413 one below) deal with it
    except Exception:
        app.logger.exception("Unexpected conversion failure")
        return jsonify(error="Something went wrong while converting. Try another image."), 500


@app.errorhandler(413)
def too_large(_err):
    return jsonify(error=f"File is too large. The limit is {MAX_UPLOAD_BYTES // (1024 * 1024)} MB."), 413


if __name__ == "__main__":
    app.run(debug=os.environ.get("FLASK_DEBUG") == "1")   # never debug=True in production
