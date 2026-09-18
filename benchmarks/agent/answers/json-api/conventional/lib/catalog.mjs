export const categories = new Set(['stationery', 'lighting']);
export const products = [
  { id: 1, name: 'Notebook', category: 'stationery', price: 4.5 },
  { id: 2, name: 'Fountain pen', category: 'stationery', price: 32 },
  { id: 3, name: 'Desk lamp', category: 'lighting', price: 58 },
];
export const byCategory = category => category === null ? products : products.filter(p => p.category === category);
export const byId = id => products.find(p => p.id === id);
