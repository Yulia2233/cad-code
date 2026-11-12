import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root=path.resolve(import.meta.dirname,'..');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'multi/vendor-manifest.json')));
for(const [relative,expected] of Object.entries(manifest.files)){
 const file=path.join(root,relative);
 const actual=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 if(actual!==expected)throw Error('Vendor hash mismatch: '+relative);
}
console.log('Verified '+Object.keys(manifest.files).length+' pinned extension files');
