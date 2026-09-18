export const users = [
  { id: 1, name: 'ada', active: true },
  { id: 2, name: 'grace', active: true },
  { id: 3, name: 'linus', active: false },
];
export const stats = () => ({ users: users.length, active: users.filter(u => u.active).length });
export const disabled = id => { const user = users.find(u => u.id === id); return user && { ...user, active: false }; };
