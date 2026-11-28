// What a search compares: the typed text and the stored field are both reduced
// to this. Names are stored in capitals without accents («ΔΟΚΙΜΟΠΟΥΛΟΣ»), Greek
// is typed with them («Δοκιμόπουλος»). Lower-casing comes first because it is
// what turns a final Σ into ς, which is then folded to σ with the rest.
export function searchKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ς/g, 'σ')
    .replace(/\s|\.|-/g, '');
}
