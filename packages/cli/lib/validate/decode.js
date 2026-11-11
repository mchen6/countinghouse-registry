'use strict';
// The properties upstream's body decode accepts. Upstream's handlers take the body
// as Go structs through huma v2, whose schemas refuse any property a struct does
// not have ("unexpected property", 422, before any validator runs). Probed against
// the official POST /v0.1/validate on 2026-11-11: an unknown top-level field and a
// _meta key beside publisher-provided were both refused. The structs are
// pkg/api/v0/types.go ServerJSON and ServerMeta and pkg/model/types.go at 7e8fa024
// (embedded structs flattened); publisher-provided is a free-form map.
const INPUT = ['description', 'isRequired', 'format', 'value', 'isSecret', 'default', 'placeholder', 'choices'];

const STRUCTS = {
  ServerJSON: {fields: ['$schema', 'name', 'description', 'title', 'repository', 'version', 'websiteUrl', 'icons', 'packages', 'remotes', '_meta'],
    nested: {repository: 'Repository', icons: ['Icon'], packages: ['Package'], remotes: ['Transport'], _meta: 'ServerMeta'}},
  ServerMeta: {fields: ['io.modelcontextprotocol.registry/publisher-provided'], nested: {}},
  Repository: {fields: ['url', 'source', 'id', 'subfolder'], nested: {}},
  Icon: {fields: ['src', 'mimeType', 'sizes', 'theme'], nested: {}},
  Package: {fields: ['registryType', 'registryBaseUrl', 'identifier', 'version', 'fileSha256', 'runtimeHint', 'transport', 'runtimeArguments', 'packageArguments', 'environmentVariables'],
    nested: {transport: 'Transport', runtimeArguments: ['Argument'], packageArguments: ['Argument'], environmentVariables: ['KeyValueInput']}},
  Transport: {fields: ['type', 'url', 'headers', 'variables'], nested: {headers: ['KeyValueInput'], variables: {map: 'Input'}}},
  Input: {fields: INPUT, nested: {}},
  KeyValueInput: {fields: [...INPUT, 'variables', 'name'], nested: {variables: {map: 'Input'}}},
  Argument: {fields: [...INPUT, 'variables', 'type', 'name', 'valueHint', 'isRepeated'], nested: {variables: {map: 'Input'}}}
};

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// -> [{message: 'unexpected property', location: 'body.<path>', value: <the object>}],
// in document order; a value of the wrong type is left to the schema check.
function decodeErrors(doc) {
  const out = [];
  const visit = (value, type, where) => {
    if (Array.isArray(type)) {
      if (Array.isArray(value)) value.forEach((v, i) => visit(v, type[0], `${where}[${i}]`));
      return;
    }
    if (type && type.map) {
      if (isObject(value)) for (const [k, v] of Object.entries(value)) visit(v, type.map, `${where}.${k}`);
      return;
    }
    if (!isObject(value)) return;
    const struct = STRUCTS[type];
    for (const key of Object.keys(value)) {
      if (!struct.fields.includes(key)) out.push({message: 'unexpected property', location: `${where}.${key}`, value});
      else if (struct.nested[key]) visit(value[key], struct.nested[key], `${where}.${key}`);
    }
  };
  visit(doc, 'ServerJSON', 'body');
  return out;
}

module.exports = {decodeErrors};
