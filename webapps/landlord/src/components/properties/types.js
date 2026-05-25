const types = [
  { id: 'store', labelId: 'Store' },
  { id: 'building', labelId: 'Building' },
  { id: 'apartment', labelId: 'Apartment' },
  { id: 'room', labelId: 'Room' },
  { id: 'office', labelId: 'Office' },
  { id: 'garage', labelId: 'Garage' },
  { id: 'parking', labelId: 'Parking spot' },
  { id: 'letterbox', labelId: 'Mailbox' },
  // Wave-17 B8: αποθήκη / storage room — common property type for Greek
  // landlords (cellar, basement storage). Single canonical 'storage' id;
  // i18n label varies per locale (Storage / Αποθήκη / Lager / ...).
  { id: 'storage', labelId: 'Storage' }
];

export default types;
