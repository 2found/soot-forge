"""Check Codex's public login status without reading or returning credentials."""
import os
import shutil
import subprocess

INSTALL_URL = 'https://developers.openai.com/codex/cli'
AUTH_URL = 'https://developers.openai.com/codex/auth'


def result(code, message, steps, can_prepare=False, auth_method=None):
    return {
        'status': 'ready' if can_prepare else 'blocked',
        'code': code,
        'canPrepare': can_prepare,
        'message': message,
        'steps': steps,
        'authMethod': auth_method,
        'checkedOn': 'soot_host_os_account',
        'imageGeneration': 'not_checked',
    }


def check_codex():
    # Soot executable tools receive only explicitly granted environment names.
    # Missing host context must not be misreported as the user's missing login.
    if not os.environ.get('PATH') or not (os.environ.get('HOME') or os.environ.get('CODEX_HOME')):
        return result('codex_host_context_missing',
                      'Soot chưa được cấp môi trường để kiểm tra Codex. Người quản lý cần cấu hình PATH và HOME/CODEX_HOME cho pack.',
                      [{'action': 'configure_host', 'label': 'Cấp env cho pack soot-pet theo README (soot grant soot-pet)'}])
    binary = shutil.which('codex')
    login_steps = [
        {'action': 'login', 'label': 'Đăng nhập tài khoản của bạn vào Codex', 'command': 'codex login', 'url': AUTH_URL},
        {'action': 'check', 'label': 'Xác nhận đã đăng nhập', 'command': 'codex login status'},
        {'action': 'resume', 'label': 'Quay lại Soot và nhắn “Đã đăng nhập Codex, tiếp tục tạo pet”'},
    ]
    if not binary:
        return result('codex_not_installed',
                      'Tạo pet cần Codex để sinh ảnh. Chưa tìm thấy Codex CLI trên máy đang chạy Soot. Bạn hãy cài Codex và đăng nhập trước.',
                      [{'action': 'install', 'label': 'Cài Codex theo hướng dẫn chính thức', 'url': INSTALL_URL}, *login_steps])
    try:
        # Fixed command, no model-supplied argv, interactive login or API keys.
        checked = subprocess.run(
            [binary, 'login', 'status'], stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10,
            env={key: os.environ[key] for key in ('PATH', 'HOME', 'CODEX_HOME') if key in os.environ},
        )
    except (OSError, subprocess.TimeoutExpired):
        return result('codex_status_unavailable',
                      'Chưa kiểm tra được trạng thái Codex. Bạn hãy chạy codex login status trên máy đang chạy Soot rồi thử lại.',
                      [{'action': 'check', 'label': 'Kiểm tra Codex hoặc cập nhật CLI nếu lệnh không hỗ trợ',
                        'command': 'codex login status', 'url': INSTALL_URL}])
    # Output may include an API-key prefix or account details. Parse locally;
    # never include stdout/stderr, token files or account identity in a receipt.
    status = (checked.stdout + checked.stderr).decode('utf-8', errors='replace').lower()
    if checked.returncode == 0:
        method = 'chatgpt' if 'chatgpt' in status else 'api_key' if 'api key' in status else 'unknown'
        return result('codex_authenticated',
                      'Codex đã có thông tin đăng nhập. Có thể chuẩn bị pet; quyền sinh ảnh và hạn mức sẽ được xác nhận trong phiên Codex.',
                      [], can_prepare=True, auth_method=method)
    if 'not logged in' in status:
        return result('codex_login_required',
                      'Codex đã được cài nhưng chưa đăng nhập. Bạn hãy chạy codex login, hoàn tất đăng nhập rồi quay lại Soot để tiếp tục tạo pet.',
                      login_steps)
    return result('codex_status_unavailable',
                  'Codex chưa xác nhận được trạng thái đăng nhập. Bạn hãy kiểm tra bằng codex login status; Soot chưa thể kết luận là bạn chưa đăng nhập.',
                  [{'action': 'check', 'label': 'Kiểm tra trạng thái trong terminal', 'command': 'codex login status', 'url': AUTH_URL}])
