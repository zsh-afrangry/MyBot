import {officeFail} from './errors.js';

const FORBIDDEN_XML_RE = /<!(?:DOCTYPE|ENTITY)\b/iu;

export function assertSafeXml(xml) {
  if (typeof xml !== 'string') officeFail('office_corrupt_xml');
  if (FORBIDDEN_XML_RE.test(xml)) {
    officeFail('office_xml_entity_forbidden');
  }
}

export function decodeXmlEntities(text) {
  if (!text || !text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/gu, (full, entity) => {
    switch (entity) {
      case 'lt': return '<';
      case 'gt': return '>';
      case 'amp': return '&';
      case 'quot': return '"';
      case 'apos': return "'";
      default: {
        const code = entity.startsWith('#x')
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
        if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return full;
        if (code === 0) return '';
        return String.fromCodePoint(code);
      }
    }
  });
}

export function decodeOoxmlEscapes(text) {
  if (!text || !text.includes('_x')) return text;
  return text.replace(/_x([0-9A-Fa-f]{4})_/gu, (_full, hex) => {
    const code = Number.parseInt(hex, 16);
    if (!Number.isInteger(code) || code === 0) return '';
    return String.fromCodePoint(code);
  });
}

export function parseXmlAttrs(raw) {
  const attrs = Object.create(null);
  if (!raw) return attrs;
  let i = 0;
  const len = raw.length;
  while (i < len) {
    while (i < len && /[\s/]/u.test(raw[i])) i++;
    if (i >= len) break;
    const nameStart = i;
    while (i < len && !/[\s=/>]/u.test(raw[i])) i++;
    const name = raw.slice(nameStart, i);
    while (i < len && /\s/u.test(raw[i])) i++;
    if (raw[i] !== '=') {
      if (name) attrs[name] = '';
      continue;
    }
    i++;
    while (i < len && /\s/u.test(raw[i])) i++;
    const quote = raw[i];
    if (quote === '"' || quote === "'") {
      i++;
      const valStart = i;
      const closeIdx = raw.indexOf(quote, valStart);
      if (closeIdx === -1) break;
      attrs[name] = decodeXmlEntities(raw.slice(valStart, closeIdx));
      i = closeIdx + 1;
    } else {
      const valStart = i;
      while (i < len && !/[\s>]/u.test(raw[i])) i++;
      attrs[name] = decodeXmlEntities(raw.slice(valStart, i));
    }
  }
  return attrs;
}

/**
 * Iterative streaming XML scanner with XXE rejection, comments/CDATA handling,
 * and zero recursive regexes.
 */
export function scanXml(xml, {onOpenTag, onCloseTag, onText} = {}) {
  assertSafeXml(xml);
  let pos = 0;
  const len = xml.length;
  while (pos < len) {
    const lt = xml.indexOf('<', pos);
    if (lt === -1) {
      if (pos < len) onText?.(decodeXmlEntities(xml.slice(pos)));
      break;
    }
    if (lt > pos) {
      onText?.(decodeXmlEntities(xml.slice(pos, lt)));
    }
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end === -1) officeFail('office_corrupt_xml');
      pos = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end === -1) officeFail('office_corrupt_xml');
      onText?.(xml.slice(lt + 9, end));
      pos = end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end === -1) officeFail('office_corrupt_xml');
      pos = end + 2;
      continue;
    }
    const gt = findTagClose(xml, lt + 1);
    if (gt === -1) officeFail('office_corrupt_xml');
    const inside = xml.slice(lt + 1, gt).trim();
    pos = gt + 1;
    if (!inside) continue;

    if (inside[0] === '/') {
      const closeName = inside.slice(1).trim();
      onCloseTag?.(closeName);
      continue;
    }

    const selfClosing = inside.endsWith('/');
    const body = selfClosing ? inside.slice(0, -1).trimEnd() : inside;
    let spaceIdx = -1;
    for (let k = 0; k < body.length; k++) {
      if (/\s/u.test(body[k])) {
        spaceIdx = k;
        break;
      }
    }
    const name = spaceIdx === -1 ? body : body.slice(0, spaceIdx);
    const attrStr = spaceIdx === -1 ? '' : body.slice(spaceIdx + 1);
    const attrs = attrStr ? parseXmlAttrs(attrStr) : Object.create(null);
    onOpenTag?.(name, attrs, selfClosing);
    if (selfClosing) {
      onCloseTag?.(name);
    }
  }
}

function findTagClose(xml, start) {
  let quote = null;
  for (let i = start; i < xml.length; i++) {
    const ch = xml[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

export function localXmlName(name) {
  const idx = name.indexOf(':');
  return idx === -1 ? name : name.slice(idx + 1);
}
