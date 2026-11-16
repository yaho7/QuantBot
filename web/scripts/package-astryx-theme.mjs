import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const files = new Map();
function collect(root, path = "") {
  for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
    const name = path ? path + "/" + entry.name : entry.name;
    if (entry.isDirectory()) collect(root, name);
    else if (entry.isFile()) files.set(name, readFileSync(join(root, name)));
  }
}
collect(".theme-build/astryx");
for (const name of ["quantbot-theme.json", "LICENSE", "preview.png"]) files.set(name, readFileSync("theme-plugins/astryx/" + name));
collect("theme-plugins/astryx", "licenses");

// Fixed timestamps, sorted paths and stored entries keep ZIPs reproducible
// across Node/zlib versions and CPU architectures.
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
const local = [], central = [];
let offset = 0;
for (const [path, data] of [...files.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
  const name = Buffer.from(path);
  const checksum = crc32(data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x800, 6);
  header.writeUInt16LE(0x21, 12);
  header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(name.length, 26);
  local.push(header, name, data);
  const record = Buffer.alloc(46);
  record.writeUInt32LE(0x02014b50, 0);
  record.writeUInt16LE(0x314, 4);
  record.writeUInt16LE(20, 6);
  record.writeUInt16LE(0x800, 8);
  record.writeUInt16LE(0x21, 14);
  record.writeUInt32LE(checksum, 16);
  record.writeUInt32LE(data.length, 20);
  record.writeUInt32LE(data.length, 24);
  record.writeUInt16LE(name.length, 28);
  record.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  record.writeUInt32LE(offset, 42);
  central.push(record, name);
  offset += header.length + name.length + data.length;
}
const directory = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.size, 8);
end.writeUInt16LE(files.size, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);
writeFileSync("dist/astryx-theme.zip", Buffer.concat([...local, directory, end]));
process.stdout.write("Packaged dist/astryx-theme.zip\n");
