// One output contract for worker validation, artifact registration and delivery. docs/22.
export function selectedOutputs(value = 'dual') {
  if (value === 'dual' || value === 'mono') return [value];
  if (value === 'both') return ['dual', 'mono'];
  throw Object.assign(Error('Invalid PDF output preference'), {code: 'invalid_pdf_output'});
}
