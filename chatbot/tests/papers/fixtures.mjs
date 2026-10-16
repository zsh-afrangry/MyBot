// Portable synthetic PDF fixture, no production file/model/network. Owned by docs/22.
export function pdf(text = 'A scholarly translation test with a formula E = mc2.') {
  const stream = `BT /F1 14 Tf 72 700 Td (${text.replace(/[()\\]/g,'')}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let out = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object,i) => {offsets.push(Buffer.byteLength(out)); out += `${i+1} 0 obj\n${object}\nendobj\n`;});
  const offset = Buffer.byteLength(out);
  out += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${offset}\n%%EOF\n`;
  return Buffer.from(out);
}
