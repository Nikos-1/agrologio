// Sets the program icon and version info on the Windows .exe without wine (pure JS via resedit).
const fs = require('fs'), path = require('path');
exports.default = async ctx => {
  if (ctx.electronPlatformName !== 'win32') return;
  const ResEdit = await import('resedit');
  const R = ResEdit.default || ResEdit;
  const exe = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.exe`);
  const ntExe = R.NtExecutable.from(fs.readFileSync(exe), { ignoreCert: true }); const rsrc = R.NtExecutableResource.from(ntExe);
  const ico = R.Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'build/icon.ico')));
  R.Resource.IconGroupEntry.replaceIconsForResource(rsrc.entries, 1, 1033, ico.icons.map(i => i.data));
  const vi = R.Resource.VersionInfo.fromEntries(rsrc.entries)[0];
  const v = ctx.packager.appInfo.version.split('.').map(Number);
  vi.setFileVersion(v[0], v[1], v[2], 0, 1033); vi.setProductVersion(v[0], v[1], v[2], 0, 1033);
  vi.setStringValues({ lang: 1033, codepage: 1200 }, { FileDescription: 'Αγρολόγιο', ProductName: 'Αγρολόγιο', CompanyName: 'Agrologio', OriginalFilename: path.basename(exe), LegalCopyright: '' });
  vi.outputToResourceEntries(rsrc.entries);
  rsrc.outputResource(ntExe);
  fs.writeFileSync(exe, Buffer.from(ntExe.generate()));
  console.log('  • icon and version info set on', path.basename(exe));
};
