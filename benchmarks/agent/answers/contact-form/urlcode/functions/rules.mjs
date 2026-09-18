export function validate(input) {
  const errors = [], field = name => (typeof input === 'object' && input !== null && typeof input[name] === 'string') ? input[name] : '';
  const name = field('name'), email = field('email'), message = field('message');
  if (name.length < 1 || name.length > 80) errors.push('name must be 1-80 characters');
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) errors.push('email must be an address');
  if (message.length < 1 || message.length > 2000) errors.push('message must be 1-2000 characters');
  return errors;
}
