const fieldLabels = {
  email: 'Email address',
  text: 'Written response',
  textarea: 'Written response',
  tel: 'Phone number',
  number: 'Number',
  url: 'Website',
  date: 'Date',
  checkbox: 'Yes or no',
};

export function publicAppActionLibraryCopy(action) {
  const fields = action.fields.map(field => {
    const label = fieldLabels[field.type] ?? 'Response';
    return `${label} (${field.required ? 'required' : 'optional'})`;
  });

  return {
    label: 'Response form',
    detail: fields.length
      ? `Collects ${fields.join(', ')}. Responses go to this app.`
      : 'Collects visitor responses. Responses go to this app.',
  };
}
