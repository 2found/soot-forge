import { run } from './catalog.mjs';

export async function archivePack(directory, output, id) {
  await run('python3', ['-c', `
import gzip, pathlib, sys, tarfile
root, output, name = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
with open(output, 'wb') as blob, gzip.GzipFile(filename='', mode='wb', fileobj=blob, mtime=0) as gz, tarfile.open(fileobj=gz, mode='w') as archive:
    for path in [root, *sorted(root.rglob('*'))]:
        item = archive.gettarinfo(str(path), arcname=name if path == root else name+'/'+str(path.relative_to(root)))
        item.uid = item.gid = item.mtime = 0
        item.uname = item.gname = ''
        item.mode = 0o755 if path.is_dir() or path.stat().st_mode & 0o111 else 0o644
        if path.is_file():
            with path.open('rb') as content: archive.addfile(item, content)
        else: archive.addfile(item)
`, directory, output, id], { timeout: 30_000, maxBuffer: 1024 * 1024 });
}
