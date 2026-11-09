/** Generate and serve harmless deterministic bytes and genuine BitTorrent metadata on loopback. */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import {pathToFileURL} from "node:url";
const [root, torlink = "/opt/torlink", sizeString = "1048576"] = process.argv.slice(2);
if (!root?.startsWith("/")) throw new Error("Supply an absolute disposable project root");
const createTorrent = (await import(pathToFileURL(path.join(torlink,"node_modules/create-torrent/index.js")))).default;
const parseTorrent = (await import(pathToFileURL(path.join(torlink,"node_modules/parse-torrent/index.js")))).default;
const directory = path.join(root,"canary-seed"); fs.mkdirSync(directory,{recursive:true});
const name = "Hoardarr Demo 2026.1080p.WEB-DL.mkv", payload = path.join(directory,name);
const size = Number(sizeString);
if (!Number.isSafeInteger(size) || size < 1 || size > 15 * 1024**3) throw new Error("Invalid synthetic payload size");
const fd = fs.openSync(payload,"w",0o600), chunk = Buffer.alloc(1024*1024,0x51);
for (let position=0; position<size; position+=chunk.length) fs.writeSync(fd,chunk,0,Math.min(chunk.length,size-position));
fs.fsyncSync(fd); fs.closeSync(fd);
const metadata = await new Promise((resolve,reject)=>createTorrent(payload,{name,private:true,announceList:[],urlList:["http://127.0.0.1:9090/payload"]},(err,buf)=>err?reject(err):resolve(buf)));
const torrent = await parseTorrent(metadata);
fs.writeFileSync(path.join(directory,"canary.torrent"),metadata,{mode:0o600});
const magnet = `magnet:?xt=urn:btih:${torrent.infoHash}&xs=${encodeURIComponent("http://127.0.0.1:9090/meta.torrent")}&ws=${encodeURIComponent("http://127.0.0.1:9090/payload")}`;
fs.writeFileSync(path.join(root,"downloads/.canary-torrent.json"),JSON.stringify({infoHash:torrent.infoHash,magnet,name,sizeBytes:size}),{mode:0o600});
http.createServer((req,res)=>{
  if (req.url === "/meta.torrent") {res.writeHead(200,{"Content-Type":"application/x-bittorrent","Content-Length":metadata.length});res.end(metadata);return;}
  if (req.url !== "/payload") {res.writeHead(404);res.end();return;}
  const match = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  const start = match?Number(match[1]):0, end = match&&match[2]?Math.min(Number(match[2]),size-1):size-1;
  if (start<0 || start>end || end>=size) {res.writeHead(416);res.end();return;}
  res.writeHead(match?206:200,{"Content-Length":end-start+1,"Content-Type":"application/octet-stream","Accept-Ranges":"bytes",...(match?{"Content-Range":`bytes ${start}-${end}/${size}`}:{})});
  fs.createReadStream(payload,{start,end}).pipe(res);
}).listen(9090,"127.0.0.1",()=>console.log(JSON.stringify({synthetic:true,infoHash:torrent.infoHash,bytes:size})));
