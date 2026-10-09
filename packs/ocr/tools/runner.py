"""Read native PDF text first; use a host-bound DeepSeek OCR endpoint for scans."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import *
import base64
import io


def page_list(args, total):
    values = args.get("pages", [0])
    require(isinstance(values, list) and 0 < len(values) <= 8 and len(set(values)) == len(values),
            "select 1..8 distinct zero-based pages per call")
    return [integer(v, "page", 0, total-1) for v in values]


def pdf_text(page):
    with contextlib.closing(page.get_textpage()) as textpage:
        text = textpage.get_text_range()
    return text.replace("\r\n", "\n")


def assess(args):
    fields(args, ("path", "pages"), ("path",))
    p = path(args["path"], suffixes={".pdf", ".png", ".jpg", ".jpeg", ".webp", ".tiff"})
    if p.suffix.lower() != ".pdf":
        require("pages" not in args, "pages applies only to PDF")
        return {"source": receipt(p), "route": "deepseek-ocr", "reason": "image input",
                "limitation": "No universal GPT/Claude comparison is claimed; validate difficult documents against ground truth."}
    import pypdfium2 as pdfium
    with pdfium.PdfDocument(p) as doc:
        pages = []
        for index in page_list(args, len(doc)):
            with contextlib.closing(doc[index]) as page:
                text = pdf_text(page)
                usable = len(text.strip()) >= 30 and text.count("\ufffd") < max(2, len(text)//100)
                pages.append({"page": index, "characters": len(text), "text_preview": text[:2000],
                              "route": "native-text" if usable else "deepseek-ocr",
                              "text_layer_only": True})
        return {"source": receipt(p), "total_pages": len(doc), "pages": pages,
                "warning": "A usable text layer does not prove completeness, table structure or reading order. Force OCR after visual comparison when needed."}


def image_bytes(p, page=None):
    from PIL import Image, ImageOps
    if p.suffix.lower() == ".pdf":
        import pypdfium2 as pdfium
        with pdfium.PdfDocument(p) as doc:
            with contextlib.closing(doc[page]) as obj:
                width, height = obj.get_size()
                scale = min(2, (16_000_000 / max(width*height, 1))**.5)
                bitmap = obj.render(scale=scale)
                try:
                    image = bitmap.to_pil().convert("RGB")
                finally:
                    bitmap.close()
    else:
        with Image.open(p) as source:
            require(source.width * source.height <= 32_000_000, "image exceeds pixel limit")
            require(getattr(source, "n_frames", 1) == 1, "multi-frame images need separate page files")
            image = ImageOps.exif_transpose(source).convert("RGB")
    image.thumbnail((2400, 2400))
    b = io.BytesIO()
    image.save(b, format="PNG")
    require(b.tell() <= 12 * 1024 * 1024, "encoded page exceeds 12 MiB")
    return b.getvalue()


def recognize(args):
    fields(args, ("path", "pages", "output", "force"), ("path", "output"))
    p = path(args["path"], suffixes={".pdf", ".png", ".jpg", ".jpeg", ".webp", ".tiff"})
    # Reject output conflicts before spending inference credits.
    path(args["output"], existing=False, suffixes={".md"})
    require(type(args.get("force", False)) is bool, "force must be boolean")
    force = args.get("force", False)
    cfg = None
    results = []
    if p.suffix.lower() == ".pdf":
        import pypdfium2 as pdfium
        with pdfium.PdfDocument(p) as doc:
            indices = page_list(args, len(doc))
            for index in indices:
                with contextlib.closing(doc[index]) as page:
                    text = pdf_text(page)
                results.append({"page": index, "text": text,
                                "engine": "native-text" if not force and len(text.strip()) >= 30 and
                                text.count("\ufffd") < max(2, len(text)//100) else "deepseek-ocr"})
    else:
        require("pages" not in args, "pages applies only to PDF")
        results.append({"page": 0, "text": "", "engine": "deepseek-ocr"})
    for row in results:
        if row["engine"] == "native-text":
            continue
        if cfg is None:
            cfg = binding("OCR_BINDING")
            base = endpoint(cfg.get("base_url", ""))
            model = string(cfg.get("model", "deepseek-ai/DeepSeek-OCR-2"), "OCR model", 200)
            require("deepseek" in model.lower() and "ocr" in model.lower(), "bind a DeepSeek OCR model, not a chat model")
        encoded = base64.b64encode(image_bytes(p, row["page"])).decode()
        prompt = "<image>\n<|grounding|>Convert the document to markdown."
        payload = {"model": model, "messages": [{"role": "user", "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64," + encoded}}]}],
            "temperature": 0, "max_tokens": 8192, "stream": False}
        raw, _ = http(base + "/chat/completions", method="POST", data=payload,
                      token=cfg.get("api_key"), timeout=180, maximum=2*1024*1024)
        response = json_response(raw)
        choices = response.get("choices")
        require(isinstance(choices, list) and choices, "OCR endpoint returned no choices")
        require(choices[0].get("finish_reason") == "stop", "OCR response incomplete; crop the page and retry with a new output")
        text = choices[0].get("message", {}).get("content")
        row["text"] = string(text, "OCR text", 200000)
        row["model"] = model
    require(sum(len(r["text"]) for r in results) <= 1_000_000, "OCR text too large")
    markdown = "\n\n".join(f"<!-- source-page: {r['page'] + 1}; engine: {r['engine']} -->\n\n{r['text']}" for r in results)
    with output(args["output"], {".md"}) as temp:
        temp.write_text(markdown, encoding="utf-8")
    return {"output": receipt(path(args["output"])), "source": receipt(p),
            "pages": [{k: v for k, v in r.items() if k != "text"} for r in results],
            "verification": "pending visual/ground-truth review; no calibrated confidence supplied"}


if __name__ == "__main__":
    invoke("ocr", {"assess": assess, "recognize": recognize})
