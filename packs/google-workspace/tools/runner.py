"""Google Workspace REST: Docs, Sheets and Drive with bounded durable actions."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import *
import time
import uuid


DOCS = "https://docs.googleapis.com/v1"
DRIVE = "https://www.googleapis.com/drive/v3"
SHEETS = "https://sheets.googleapis.com/v4"
SCOPES = ["https://www.googleapis.com/auth/documents", "https://www.googleapis.com/auth/drive.file"]


def auth(surface="docs"):
    cfg = binding("GOOGLE_WORKSPACE_BINDING")
    # Production origins are fixed. Tests inject transport, never model-controlled URLs.
    kind = cfg.get("type", "access_token")
    if kind == "access_token":
        token = string(cfg.get("access_token"), "Google access token", 16000)
        expires = cfg.get("expires_at")
        import math
        require(type(expires) in (int, float) and math.isfinite(expires) and expires > time.time() + 30,
                "Google access token expired or expires_at missing; refresh through the host")
        return token
    from google.auth.transport.requests import Request
    if kind == "service_account":
        from google.oauth2 import service_account
        info = cfg.get("service_account")
        require(isinstance(info, dict) and info.get("token_uri") == "https://oauth2.googleapis.com/token",
                "service account must use Google's token URI")
        credentials = service_account.Credentials.from_service_account_info(info, scopes=SCOPES if surface == "docs" else SCOPES[-1:])
    elif kind == "oauth_refresh":
        from google.oauth2.credentials import Credentials
        credentials = Credentials(token=None, refresh_token=string(cfg.get("refresh_token"), "refresh token", 10000),
                                  client_id=string(cfg.get("client_id"), "client ID", 1000),
                                  client_secret=string(cfg.get("client_secret"), "client secret", 1000),
                                  token_uri="https://oauth2.googleapis.com/token", scopes=SCOPES if surface == "docs" else SCOPES[-1:])
    else:
        raise ToolError("unknown Google credential type")
    try:
        transport = Request()
        # The SDK default token timeout exceeds the tool's execution deadline.
        # Bound a refresh explicitly; tokens remain transient and host-owned.
        credentials.refresh(lambda *args, **kwargs: transport(*args, **{**kwargs, "timeout":15}))
    except Exception:
        raise ToolError("Google authorization failed; refresh or rebind credentials through the host") from None
    return credentials.token


def document_id(value):
    require(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{10,200}", value), "invalid Google document ID")
    return value


def request(url, method="GET", data=None, mutation=False, token=None, maximum=8*1024*1024, surface="docs"):
    raw, headers = http(url, method=method, data=data, token=token or auth(surface), mutation=mutation, maximum=maximum)
    return json_response(raw, mutation=mutation)


def docs_list(args):
    fields(args, ("page_token", "limit"))
    limit = integer(args.get("limit", 20), "limit", 1, 100)
    query = {"q": "mimeType = 'application/vnd.google-apps.document' and trashed = false",
             "pageSize": limit, "orderBy": "modifiedTime desc",
             "fields": "nextPageToken,files(id,name,modifiedTime,webViewLink)"}
    if args.get("page_token"):
        query["pageToken"] = string(args["page_token"], "page token", 2000)
    return request(DRIVE + "/files?" + urllib.parse.urlencode(query))


def walk_tabs(tabs):
    for tab in tabs:
        yield tab
        yield from walk_tabs(tab.get("childTabs", []))


def extract_content(elements):
    rows = []
    for item in elements:
        if "paragraph" in item:
            p = item["paragraph"]
            rows.append({"start_index": item.get("startIndex"), "end_index": item.get("endIndex"),
                         "kind": "paragraph", "text": "".join(e.get("textRun", {}).get("content", "")
                          for e in p.get("elements", []))[:10000], "style": p.get("paragraphStyle", {}).get("namedStyleType")})
        elif "table" in item:
            table = item["table"]
            rows.append({"start_index": item.get("startIndex"), "end_index": item.get("endIndex"), "kind": "table",
                         "rows": [[extract_content(cell.get("content", [])) for cell in row.get("tableCells", [])[:20]]
                                  for row in table.get("tableRows", [])[:30]]})
        elif "sectionBreak" in item:
            rows.append({"kind": "section_break", "start_index": item.get("startIndex")})
    return rows


def docs_read(args):
    fields(args, ("document_id", "tab_id", "start", "limit"), ("document_id",))
    identifier = document_id(args["document_id"])
    data = request(DOCS + "/documents/" + identifier + "?includeTabsContent=true")
    tabs = list(walk_tabs(data.get("tabs", [])))
    # Legacy single-body responses remain readable, but new writes should select tabs explicitly.
    if not tabs and "body" in data:
        tabs = [{"tabProperties": {"tabId": "", "title": "Document"}, "documentTab": {"body": data["body"]}}]
    require(tabs, "document returned no readable tabs")
    tab_id = args.get("tab_id", tabs[0].get("tabProperties", {}).get("tabId", ""))
    require(isinstance(tab_id, str), "invalid tab_id")
    tab = next((t for t in tabs if t.get("tabProperties", {}).get("tabId") == tab_id), None)
    require(tab is not None, "unknown tab ID")
    start = integer(args.get("start", 0), "start", 0, 1000000)
    limit = integer(args.get("limit", 20), "limit", 1, 100)
    elements = tab.get("documentTab", {}).get("body", {}).get("content", [])
    return {"document_id": identifier, "title": data.get("title"), "revision_id": data.get("revisionId"),
            "tabs": [t.get("tabProperties", {}) for t in tabs], "tab_id": tab_id,
            "content": extract_content(elements[start:start+limit]), "total": len(elements),
            "next_start": start + limit if start + limit < len(elements) else None,
            "index_unit": "UTF-16 code units; Google API indexes are not Python character indexes"}


def durable_action(action_id, payload, work):
    require(isinstance(action_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,64}", action_id), "invalid action_id")
    cfg = binding("GOOGLE_WORKSPACE_BINDING")
    account = cfg.get("account_id") or cfg.get("service_account", {}).get("client_email")
    string(account, "host account_id for mutation receipts", 300)
    directory = root() / "google-workspace-receipts"
    require(not directory.is_symlink(), "receipt directory must not be a symlink")
    directory.mkdir(mode=0o700, exist_ok=True)
    sync_directory(directory.parent)
    directory = directory / hashlib.sha256(account.encode()).hexdigest()[:32]
    require(not directory.is_symlink(), "account receipt directory must not be a symlink")
    directory.mkdir(mode=0o700, exist_ok=True)
    sync_directory(directory.parent)
    record = directory / (action_id + ".json")
    require(not record.is_symlink(), "receipt must not be a symlink")
    fingerprint = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    pending = {"action_id": action_id, "request_sha256": fingerprint, "state": "pending"}
    try:
        fd = os.open(record, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        prior = json.loads(record.read_text())
        require(prior.get("request_sha256") == fingerprint, "action_id belongs to different input")
        if prior.get("state") == "completed":
            return {**prior["result"], "replayed_receipt": True}
        raise Uncertain("action has a pending/failed receipt; inspect Google before submitting another action")
    with os.fdopen(fd, "w") as f:
        json.dump(pending, f)
        f.flush()
        os.fsync(f.fileno())
    sync_directory(directory)
    # Persist before sending. A crash, Stop or failed receipt commit never replays a mutation.
    try:
        result = work()
        pending.update(state="completed", result=result)
        fd, filename = tempfile_record(directory)
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(pending, f, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno())
            os.replace(filename, record)
            sync_directory(directory)
        finally:
            Path(filename).unlink(missing_ok=True)
        return result
    except ToolError:
        raise
    except Exception:
        raise Uncertain("mutation or receipt commit failed; reconcile Google before retry") from None


def tempfile_record(directory):
    import tempfile
    return tempfile.mkstemp(prefix=".receipt-", dir=directory)


def sync_directory(directory):
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def docs_create(args):
    fields(args, ("title", "action_id"), ("title", "action_id"))
    title = string(args["title"], "title", 300)
    token = auth()  # authorize before reserving a durable action
    def work():
        response = request(DOCS + "/documents", "POST", {"title": title}, mutation=True, token=token)
        identifier = response.get("documentId")
        try:
            document_id(identifier)
        except ToolError:
            raise Uncertain("created document ID missing; reconcile Drive before retry") from None
        return {"document_id": identifier, "title": response.get("title", title),
                "url": "https://docs.google.com/document/d/" + identifier + "/edit", "shared": False}
    return durable_action(args["action_id"], {"operation": "create", "title": title}, work)


def docs_batch_update(args):
    fields(args, ("document_id", "revision_id", "spec", "action_id"),
           ("document_id", "revision_id", "spec", "action_id"))
    identifier = document_id(args["document_id"])
    revision = string(args["revision_id"], "required revision", 500)
    p = path(args["spec"], suffixes={".json"}, max_bytes=512*1024)
    data = json.loads(p.read_text())
    fields(data, ("requests",), ("requests",))
    requests = data["requests"]
    require(isinstance(requests, list) and 0 < len(requests) <= 100, "requests must contain 1..100 operations")
    allowed = {"insertText", "replaceAllText", "updateTextStyle", "updateParagraphStyle",
               "insertTable", "deleteContentRange", "insertPageBreak", "createParagraphBullets", "deleteParagraphBullets"}
    for row in requests:
        require(isinstance(row, dict) and len(row) == 1 and set(row).issubset(allowed), "unsupported Docs request")
        kind, body = next(iter(row.items()))
        require(isinstance(body, dict), "invalid Docs request body")
        if kind == "replaceAllText":
            require(isinstance(body.get("tabsCriteria", {}).get("tabIds"), list) and
                    body["tabsCriteria"]["tabIds"], "replaceAllText needs explicit tabsCriteria.tabIds")
        else:
            location = body.get("location", body.get("range", body.get("endOfSegmentLocation", {})))
            require(isinstance(location, dict) and isinstance(location.get("tabId"), str) and
                    location["tabId"], "write requests need an explicit tabId in location/range")
        if kind in ("updateTextStyle", "updateParagraphStyle"):
            require(body.get("fields") and body["fields"] != "*", "use a precise style field mask")
    payload = {"requests": requests, "writeControl": {"requiredRevisionId": revision}}
    token = auth()
    def work():
        response = request(DOCS + "/documents/" + identifier + ":batchUpdate", "POST", payload,
                           mutation=True, token=token)
        if response.get("documentId") != identifier or not isinstance(response.get("replies"), list):
            raise Uncertain("batch success response missing document identity/replies; reconcile before retry")
        return {"document_id": identifier, "replies": response.get("replies", []),
                "write_control": response.get("writeControl", {}), "request_sha256": digest(p)}
    return durable_action(args["action_id"], {"document_id": identifier, **payload}, work)


def docs_export(args):
    fields(args, ("document_id", "format", "output"), ("document_id", "format", "output"))
    identifier = document_id(args["document_id"])
    formats = {"pdf": "application/pdf", "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
               "txt": "text/plain"}
    require(args["format"] in formats, "export supports pdf/docx/txt")
    path(args["output"], existing=False, suffixes={"." + args["format"]})
    url = DRIVE + "/files/" + identifier + "/export?" + urllib.parse.urlencode({"mimeType": formats[args["format"]]})
    raw, _ = http(url, token=auth(), maximum=10*1024*1024)
    require(raw, "Google returned an empty export")
    if args["format"] == "pdf":
        require(raw.startswith(b"%PDF-"), "Google returned invalid PDF export")
    elif args["format"] == "docx":
        require(raw.startswith(b"PK"), "Google returned invalid DOCX export")
    with output(args["output"], {"." + args["format"]}) as temp:
        temp.write_bytes(raw)
        validate_office_export(temp, args["format"])
    return receipt(path(args["output"]), document_id=identifier, mime_type=formats[args["format"]])


def validate_office_export(temp, kind):
    required = {"docx":"word/document.xml", "xlsx":"xl/workbook.xml", "pptx":"ppt/presentation.xml"}
    if kind not in required:
        return
    import zipfile
    try:
        zip_guard(temp)
        with zipfile.ZipFile(temp) as archive:
            require({"[Content_Types].xml",required[kind]}.issubset(archive.namelist()), "Google export is missing Office document parts")
            require(archive.testzip() is None, "Google export has corrupt Office parts")
    except zipfile.BadZipFile:
        raise ToolError("Google returned an invalid Office archive") from None


def a1(value):
    string(value, "explicit bounded A1 range", 300)
    match = re.fullmatch(r"(?:'(?:[^']|''){1,100}'|[A-Za-z_][A-Za-z0-9 _-]{0,99})!([A-Z]{1,3})([1-9][0-9]{0,6})(?::([A-Z]{1,3})([1-9][0-9]{0,6}))?", value)
    require(match, "range needs a tab and bounded cells, e.g. 'Chi phí'!A1:C20")
    def column(text):
        result = 0
        for char in text:
            result = result*26 + ord(char)-64
        return result
    c1, r1 = column(match[1]), int(match[2])
    c2, r2 = column(match[3] or match[1]), int(match[4] or match[2])
    require(c1 <= c2 <= 18278 and r1 <= r2 <= 1000000 and (r2-r1+1)*(c2-c1+1) <= 2000,
            "range must contain 1..2000 cells within Sheets limits")
    return r2-r1+1, c2-c1+1


def matrix(values, rows, columns, exact=False, input_option="RAW"):
    require(isinstance(values, list) and 0 < len(values) <= rows, "invalid value rows")
    if exact:
        require(len(values) == rows, "values must fill the explicit target rectangle")
    for row in values:
        require(isinstance(row, list) and 0 < len(row) <= columns and (not exact or len(row) == columns), "invalid value columns")
        for value in row:
            require(type(value) in (str, int, float, bool), "cells must be text, boolean or finite number; use empty text to clear")
            if isinstance(value, str):
                string(value, "cell text", 32767, empty=True)
                if input_option == "USER_ENTERED" and value.startswith("="):
                    require(not re.search(r"(?i)(HYPERLINK|IMPORT(?:XML|HTML|DATA|RANGE)|IMAGE\s*\(|https?://)", value), "external-data formulas require a separately reviewed integration")
            elif type(value) in (int, float):
                number(value, "cell number", -1e300, 1e300)
    return values


def sheets_info(args):
    fields(args, ("spreadsheet_id",), ("spreadsheet_id",))
    identifier = document_id(args["spreadsheet_id"])
    query = urllib.parse.urlencode({"includeGridData":"false", "fields":"spreadsheetId,spreadsheetUrl,properties,sheets.properties"})
    return request(SHEETS + "/spreadsheets/" + identifier + "?" + query, surface="sheets")


def values_read(identifier, range_value, render="FORMULA", token=None):
    rows, columns = a1(range_value)
    url = SHEETS + "/spreadsheets/" + identifier + "/values/" + urllib.parse.quote(range_value, safe="")
    response = request(url + "?" + urllib.parse.urlencode({"majorDimension":"ROWS", "valueRenderOption":render}), token=token, surface="sheets")
    values = response.get("values", [])
    require(isinstance(values, list) and len(values) <= rows and all(isinstance(r,list) and len(r) <= columns for r in values), "Google returned values outside the requested rectangle")
    normalized = [[values[r][c] if r < len(values) and c < len(values[r]) else "" for c in range(columns)] for r in range(rows)]
    snapshot = hashlib.sha256(json.dumps({"spreadsheet_id":identifier,"range":range_value,"render":render,"values":normalized},sort_keys=True,ensure_ascii=False,allow_nan=False).encode()).hexdigest()
    return {"spreadsheet_id":identifier,"range":response.get("range",range_value),"requested_range":range_value,"values":values,"render":render,"snapshot_sha256":snapshot,
            "concurrency":"Sheets snapshot check is a non-atomic preflight, not a revision lock"}


def sheets_read(args):
    fields(args, ("spreadsheet_id","range","render"), ("spreadsheet_id","range"))
    render = args.get("render", "FORMULA")
    require(render in ("FORMULA","FORMATTED_VALUE","UNFORMATTED_VALUE"), "invalid value render option")
    return values_read(document_id(args["spreadsheet_id"]), args["range"], render)


def sheets_create(args):
    fields(args, ("title","tabs","action_id"), ("title","action_id"))
    title = string(args["title"], "spreadsheet title", 300)
    tabs = args.get("tabs", ["Sheet1"])
    require(isinstance(tabs,list) and 0 < len(tabs) <= 20 and len(set(tabs)) == len(tabs), "choose 1..20 distinct tab titles")
    for tab in tabs:
        string(tab, "tab title", 100)
    payload = {"properties":{"title":title},"sheets":[{"properties":{"title":tab}} for tab in tabs]}
    token = auth("sheets")
    def work():
        response = request(SHEETS + "/spreadsheets", "POST", payload, mutation=True, token=token)
        try:
            identifier = document_id(response.get("spreadsheetId"))
        except ToolError:
            raise Uncertain("created spreadsheet identity missing; reconcile Drive before retry") from None
        return {"spreadsheet_id":identifier,"url":"https://docs.google.com/spreadsheets/d/"+identifier+"/edit","sharing_changed":False}
    return durable_action(args["action_id"], {"operation":"sheets_create",**payload}, work)


def sheet_write(args, append=False):
    required = ("spreadsheet_id","range","spec","action_id") + (() if append else ("expected_snapshot",))
    fields(args, required, required)
    identifier = document_id(args["spreadsheet_id"])
    rows, columns = a1(args["range"])
    p = path(args["spec"], suffixes={".json"}, max_bytes=512*1024)
    spec = json.loads(p.read_text())
    fields(spec, ("values","input_option"), ("values",))
    option = spec.get("input_option", "RAW")
    require(option in ("RAW","USER_ENTERED"), "invalid input_option")
    values = matrix(spec["values"], rows, columns, exact=not append, input_option=option)
    if not append:
        require(isinstance(args["expected_snapshot"],str) and re.fullmatch(r"[a-f0-9]{64}",args["expected_snapshot"]), "use the FORMULA snapshot from sheets_read")
    token = auth("sheets")
    operation = "sheets_append" if append else "sheets_update"
    payload = {"range":args["range"],"majorDimension":"ROWS","values":values}
    def work():
        if not append:
            current = values_read(identifier,args["range"],token=token)
            require(current["snapshot_sha256"] == args["expected_snapshot"], "cells changed since read; re-read and use a new action_id")
        url = SHEETS + "/spreadsheets/" + identifier + "/values/" + urllib.parse.quote(args["range"],safe="")
        query = {"valueInputOption":option}
        if append:
            url += ":append"
            query["insertDataOption"] = "INSERT_ROWS"
        response = request(url + "?" + urllib.parse.urlencode(query), "POST" if append else "PUT", payload, mutation=True, token=token)
        updates = response.get("updates", {}) if append else response
        if response.get("spreadsheetId") != identifier or not updates.get("updatedRange") or updates.get("updatedRows") != len(values):
            raise Uncertain("Sheets write identity/range/count incomplete; reconcile before retry")
        return {"spreadsheet_id":identifier,"updates":updates,"input_option":option,
                "concurrency":"append receipt prevents local replay; updates use non-atomic snapshot preflight"}
    return durable_action(args["action_id"], {"operation":operation,"spreadsheet_id":identifier,"input_option":option,**payload,
                                           **({"expected_snapshot":args["expected_snapshot"]} if not append else {})}, work)


def parent_id(value):
    return "root" if value == "root" else document_id(value)


def drive_list(args):
    fields(args, ("parent_id","kind","page_token","limit"))
    kinds = {"docs":"application/vnd.google-apps.document","sheets":"application/vnd.google-apps.spreadsheet","slides":"application/vnd.google-apps.presentation","folders":"application/vnd.google-apps.folder"}
    kind = args.get("kind", "all")
    require(kind == "all" or kind in kinds, "invalid Drive kind")
    q = "trashed = false"
    if "parent_id" in args:
        q += " and '" + parent_id(args["parent_id"]) + "' in parents"
    if kind != "all":
        q += " and mimeType = '" + kinds[kind] + "'"
    query = {"q":q,"pageSize":integer(args.get("limit",20),"limit",1,100),"orderBy":"modifiedTime desc",
             "fields":"nextPageToken,files(id,name,mimeType,size,modifiedTime,parents,webViewLink)"}
    if "page_token" in args:
        query["pageToken"] = string(args["page_token"], "page token", 2000)
    return request(DRIVE + "/files?" + urllib.parse.urlencode(query), surface="drive")


def drive_metadata(identifier, token=None):
    fields_query = "id,name,mimeType,size,md5Checksum,modifiedTime,version,parents,webViewLink,capabilities(canDownload)"
    response = request(DRIVE + "/files/" + identifier + "?" + urllib.parse.urlencode({"fields":fields_query}), token=token, surface="drive")
    require(response.get("id") == identifier, "Google returned a different file identity")
    return response


def drive_get(args):
    fields(args, ("file_id",), ("file_id",))
    return drive_metadata(document_id(args["file_id"]))


def drive_download(args):
    fields(args, ("file_id","output"), ("file_id","output"))
    identifier = document_id(args["file_id"])
    destination = path(args["output"], existing=False)
    token = auth("drive")
    meta = drive_metadata(identifier,token)
    require(not meta.get("mimeType","").startswith("application/vnd.google-apps."), "Google-native files use drive_export")
    require(meta.get("capabilities",{}).get("canDownload") is not False, "file cannot be downloaded")
    size = int(meta.get("size",0))
    require(0 < size <= 64*1024*1024, "binary download must be 1 byte..64 MiB")
    raw, _ = http(DRIVE + "/files/" + identifier + "?alt=media", token=token, maximum=size)
    require(len(raw) == size, "download size differs from metadata; file may have changed")
    if meta.get("md5Checksum"):
        require(hashlib.md5(raw).hexdigest() == meta["md5Checksum"], "download checksum differs; file may have changed")
    with output(args["output"]) as temp:
        temp.write_bytes(raw)
    return receipt(destination, file_id=identifier, mime_type=meta.get("mimeType"), version=meta.get("version"))


EXPORTS = {"pdf":"application/pdf","docx":"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
           "xlsx":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
           "pptx":"application/vnd.openxmlformats-officedocument.presentationml.presentation","txt":"text/plain","csv":"text/csv"}


def drive_export(args):
    fields(args, ("file_id","format","output"), ("file_id","format","output"))
    identifier = document_id(args["file_id"])
    kind = args["format"]
    require(kind in EXPORTS, "unsupported export format")
    destination = path(args["output"],existing=False,suffixes={"."+kind})
    token = auth("drive")
    meta = drive_metadata(identifier,token)
    supported = {"application/vnd.google-apps.document":{"pdf","docx","txt"},
                 "application/vnd.google-apps.spreadsheet":{"pdf","xlsx","csv"},
                 "application/vnd.google-apps.presentation":{"pdf","pptx","txt"}}
    require(kind in supported.get(meta.get("mimeType"),set()), "format unsupported for this Google file type")
    raw, _ = http(DRIVE + "/files/" + identifier + "/export?" + urllib.parse.urlencode({"mimeType":EXPORTS[kind]}), token=token, maximum=10*1024*1024)
    require(raw and (kind != "pdf" or raw.startswith(b"%PDF-")) and (kind not in ("docx","xlsx","pptx") or raw.startswith(b"PK")), "Google returned invalid export")
    with output(args["output"],{"."+kind}) as temp:
        temp.write_bytes(raw)
        validate_office_export(temp, kind)
    return receipt(destination,file_id=identifier,mime_type=EXPORTS[kind],csv_scope="first sheet only" if kind == "csv" else None)


def drive_folder(args):
    fields(args, ("name","parent_id","action_id"), ("name","action_id"))
    metadata = {"name":string(args["name"],"folder name",255),"mimeType":"application/vnd.google-apps.folder"}
    if "parent_id" in args:
        metadata["parents"] = [parent_id(args["parent_id"])]
    token = auth("drive")
    def work():
        response = request(DRIVE+"/files?fields=id,name,mimeType,parents,webViewLink","POST",metadata,mutation=True,token=token)
        try:
            document_id(response.get("id"))
        except ToolError:
            raise Uncertain("created folder ID missing; reconcile Drive before retry") from None
        return {**response,"sharing_changed":False,"parent_permissions_may_apply":bool(metadata.get("parents"))}
    return durable_action(args["action_id"],{"operation":"drive_folder",**metadata},work)


def drive_upload(args):
    fields(args, ("path","name","parent_id","action_id"), ("path","action_id"))
    types = {".pdf":"application/pdf",".docx":EXPORTS["docx"],".xlsx":EXPORTS["xlsx"],".pptx":EXPORTS["pptx"],
             ".txt":"text/plain",".md":"text/markdown",".csv":"text/csv",".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".wav":"audio/wav",".mp4":"video/mp4"}
    p = path(args["path"],suffixes=set(types),max_bytes=5*1024*1024)
    require(p.stat().st_size > 0,"cannot upload empty file")
    metadata = {"name":string(args.get("name",p.name),"file name",255),"mimeType":types[p.suffix.lower()]}
    if "parent_id" in args:
        metadata["parents"] = [parent_id(args["parent_id"])]
    raw = p.read_bytes()
    require(0 < len(raw) <= 5*1024*1024, "upload content must be 1 byte..5 MiB")
    source_hash = hashlib.sha256(raw).hexdigest()
    token = auth("drive")
    def work():
        boundary = "soot_" + uuid.uuid4().hex
        body = (f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n".encode()+json.dumps(metadata,ensure_ascii=False).encode()+
                f"\r\n--{boundary}\r\nContent-Type: {metadata['mimeType']}\r\n\r\n".encode()+raw+f"\r\n--{boundary}--\r\n".encode())
        response_raw, _ = http("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,size,parents,webViewLink",method="POST",data=body,token=token,mutation=True,
                               headers={"Content-Type":"multipart/related; boundary="+boundary})
        response = json_response(response_raw,mutation=True)
        try:
            document_id(response.get("id"))
        except ToolError:
            raise Uncertain("uploaded file ID missing; reconcile Drive before retry") from None
        return {**response,"source_sha256":source_hash,"sharing_changed":False,"parent_permissions_may_apply":bool(metadata.get("parents"))}
    return durable_action(args["action_id"],{"operation":"drive_upload","source_sha256":source_hash,**metadata},work)


def drive_update(args):
    fields(args, ("file_id","expected_version","name","parent_id","action_id"), ("file_id","expected_version","action_id"))
    identifier = document_id(args["file_id"])
    version = string(args["expected_version"],"expected Drive version",100)
    require(re.fullmatch(r"[0-9]{1,100}", version), "use the numeric version returned by drive_get")
    require("name" in args or "parent_id" in args,"rename or parent change required")
    name = string(args["name"],"new file name",255) if "name" in args else None
    parent = parent_id(args["parent_id"]) if "parent_id" in args else None
    token = auth("drive")
    def work():
        current = drive_metadata(identifier,token)
        require(str(current.get("version")) == version,"file changed since read; re-read and use a new action_id")
        query = {"fields":"id,name,mimeType,parents,version,webViewLink"}
        if parent is not None and parent not in current.get("parents",[]):
            query["addParents"] = parent
            if current.get("parents"):
                query["removeParents"] = ",".join(current["parents"])
        response = request(DRIVE+"/files/"+identifier+"?"+urllib.parse.urlencode(query),"PATCH",{"name":name} if name is not None else {},mutation=True,token=token)
        if response.get("id") != identifier:
            raise Uncertain("Drive update identity missing; reconcile before retry")
        return {**response,"sharing_changed":False,"parent_permissions_may_apply":parent is not None,
                "concurrency":"version preflight only; not an atomic revision lock"}
    return durable_action(args["action_id"],{"operation":"drive_update","file_id":identifier,"expected_version":version,"name":name,"parent_id":parent},work)


if __name__ == "__main__":
    invoke("google-workspace", {"docs_list":docs_list,"docs_read":docs_read,"docs_create":docs_create,"docs_batch_update":docs_batch_update,"docs_export":docs_export,
        "sheets_info":sheets_info,"sheets_read":sheets_read,"sheets_create":sheets_create,"sheets_update":lambda a:sheet_write(a),"sheets_append":lambda a:sheet_write(a,True),
        "drive_list":drive_list,"drive_get":drive_get,"drive_download":drive_download,"drive_export":drive_export,"drive_folder":drive_folder,"drive_upload":drive_upload,"drive_update":drive_update})
