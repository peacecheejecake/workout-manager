import { TrackIngestionError, type ParseBudget, type TrackParseLimits } from './limits.js';

export type XmlEvent =
  | {
      readonly kind: 'open';
      readonly name: string;
      readonly attributes: ReadonlyMap<string, string>;
    }
  | { readonly kind: 'close'; readonly name: string }
  | { readonly kind: 'text'; readonly value: string };

const MAX_ATTRIBUTES = 32;
const NAME = /[^\s/>]+/y;
const encoder = new TextEncoder();

const NAMED_ENTITIES = new Map([
  ['lt', '<'],
  ['gt', '>'],
  ['amp', '&'],
  ['apos', "'"],
  ['quot', '"'],
]);

/**
 * Decodes only the five predefined XML entities and numeric character references.
 * Any other reference is a (possibly external) custom entity and is blocked.
 */
export function decodeXmlText(value: string): string {
  if (!value.includes('&')) return value;
  let result = '';
  let index = 0;
  while (index < value.length) {
    const ampersand = value.indexOf('&', index);
    if (ampersand < 0) {
      result += value.slice(index);
      break;
    }
    result += value.slice(index, ampersand);
    const end = value.indexOf(';', ampersand);
    if (end < 0 || end - ampersand > 12) throw new TrackIngestionError('TRACK_XML_ENTITY_BLOCKED');
    const reference = value.slice(ampersand + 1, end);
    const named = NAMED_ENTITIES.get(reference);
    if (named !== undefined) result += named;
    else if (/^#[0-9]+$/.test(reference) || /^#x[0-9a-fA-F]+$/.test(reference)) {
      const code = reference.startsWith('#x')
        ? Number.parseInt(reference.slice(2), 16)
        : Number.parseInt(reference.slice(1), 10);
      if (!Number.isInteger(code) || code < 1 || code > 0x10ffff)
        throw new TrackIngestionError('TRACK_XML_ENTITY_BLOCKED');
      result += String.fromCodePoint(code);
    } else throw new TrackIngestionError('TRACK_XML_ENTITY_BLOCKED');
    index = end + 1;
  }
  return result;
}

/**
 * Bounded, dependency-free XML scanner for GPX. It never resolves a DTD, an external
 * entity, an external reference or a namespace URL; DOCTYPE is refused outright.
 */
export function* scanXml(
  source: string,
  limits: TrackParseLimits,
  budget: ParseBudget,
): Generator<XmlEvent> {
  const stack: string[] = [];
  let index = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (index < source.length) {
    budget.check();
    if (source[index] !== '<') {
      const next = source.indexOf('<', index);
      const raw = source.slice(index, next < 0 ? source.length : next);
      if (encoder.encode(raw).byteLength > limits.xmlTextBytes)
        throw new TrackIngestionError('TRACK_XML_TEXT_LIMIT');
      if (raw.trim().length > 0) yield { kind: 'text', value: decodeXmlText(raw) };
      index = next < 0 ? source.length : next;
      continue;
    }
    if (source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index);
      if (end < 0) throw new TrackIngestionError('TRACK_XML_MALFORMED');
      index = end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', index)) {
      const end = source.indexOf(']]>', index);
      if (end < 0) throw new TrackIngestionError('TRACK_XML_MALFORMED');
      const raw = source.slice(index + 9, end);
      if (encoder.encode(raw).byteLength > limits.xmlTextBytes)
        throw new TrackIngestionError('TRACK_XML_TEXT_LIMIT');
      if (raw.trim().length > 0) yield { kind: 'text', value: raw };
      index = end + 3;
      continue;
    }
    if (source.startsWith('<!DOCTYPE', index) || source.startsWith('<!ENTITY', index))
      throw new TrackIngestionError('TRACK_XML_DTD_BLOCKED');
    if (source.startsWith('<!', index)) throw new TrackIngestionError('TRACK_XML_MALFORMED');
    if (source.startsWith('<?', index)) {
      const end = source.indexOf('?>', index);
      if (end < 0) throw new TrackIngestionError('TRACK_XML_MALFORMED');
      index = end + 2;
      continue;
    }
    if (source.startsWith('</', index)) {
      NAME.lastIndex = index + 2;
      const matched = NAME.exec(source);
      const end = source.indexOf('>', index);
      if (!matched || end < 0) throw new TrackIngestionError('TRACK_XML_MALFORMED');
      const name = matched[0];
      if (stack.pop() !== name) throw new TrackIngestionError('TRACK_XML_MALFORMED');
      yield { kind: 'close', name };
      index = end + 1;
      continue;
    }
    NAME.lastIndex = index + 1;
    const matched = NAME.exec(source);
    if (!matched) throw new TrackIngestionError('TRACK_XML_MALFORMED');
    const name = matched[0];
    let cursor = NAME.lastIndex;
    const attributes = new Map<string, string>();
    for (;;) {
      budget.check();
      while (cursor < source.length && /\s/.test(source[cursor] ?? '')) cursor += 1;
      if (cursor >= source.length) throw new TrackIngestionError('TRACK_XML_MALFORMED');
      if (source.startsWith('/>', cursor)) {
        // A self-closing element still occupies a nesting level, so it is depth-checked.
        if (stack.length + 1 > limits.xmlDepth)
          throw new TrackIngestionError('TRACK_XML_DEPTH_LIMIT');
        yield { kind: 'open', name, attributes };
        yield { kind: 'close', name };
        cursor += 2;
        break;
      }
      if (source[cursor] === '>') {
        stack.push(name);
        if (stack.length > limits.xmlDepth) throw new TrackIngestionError('TRACK_XML_DEPTH_LIMIT');
        yield { kind: 'open', name, attributes };
        cursor += 1;
        break;
      }
      const equals = source.indexOf('=', cursor);
      if (equals < 0) throw new TrackIngestionError('TRACK_XML_MALFORMED');
      const attributeName = source.slice(cursor, equals).trim();
      const quote = source[equals + 1];
      if (
        attributeName.length === 0 ||
        attributeName.length > limits.metadataTextLength ||
        (quote !== '"' && quote !== "'")
      )
        throw new TrackIngestionError('TRACK_XML_MALFORMED');
      const close = source.indexOf(quote, equals + 2);
      if (close < 0) throw new TrackIngestionError('TRACK_XML_MALFORMED');
      const raw = source.slice(equals + 2, close);
      if (encoder.encode(raw).byteLength > limits.xmlTextBytes)
        throw new TrackIngestionError('TRACK_XML_TEXT_LIMIT');
      // Repeating one attribute is not allowed in XML and must not slip past the cap by
      // leaving `Map.size` unchanged.
      if (attributes.has(attributeName) || attributes.size >= MAX_ATTRIBUTES)
        throw new TrackIngestionError('TRACK_XML_MALFORMED');
      attributes.set(attributeName, decodeXmlText(raw));
      cursor = close + 1;
    }
    index = cursor;
  }
  if (stack.length > 0) throw new TrackIngestionError('TRACK_XML_MALFORMED');
}

/** `gpx:trkpt` and `trkpt` are the same element for our purposes. */
export function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
}
