/**
 * Classify the TEXT of an incoming PDF into the parser lane that owns it.
 *
 * This is the Telegram orchestrator's routing decision: a PDF sent to the bot
 * is a μισθωτήριο (AADE lease declaration), an Ε9 (property statement), or a
 * bill — three lanes that already exist and must not be merged. The sniffs are
 * the SAME markers the upload routes already trust at their own boundaries
 * (pdfimportmanager rejects non-leases; buildingmanager.importFromE9 rejects
 * non-E9s); this module only decides ORDER, cheaply enough to run on the poll
 * tick before the InboxItem row is written, so the bell's processing card can
 * name what is being read.
 *
 * ORDER IS THE CORRECTNESS ARGUMENT. The lease header is checked FIRST because
 * it is the most specific marker («ΔΗΛΩΣΗ ΠΛΗΡΟΦΟΡΙΑΚΩΝ ΣΤΟΙΧΕΙΩΝ ΜΙΣΘΩΣΗΣ»
 * appears on every AADE lease, original or amendment) — and because a lease
 * legitimately MENTIONS Ε9 (a property's ΑΤΑΚ «όπως δηλώθηκε στο Ε9»), so
 * testing the weak /Ε9/ token first would steal leases into the E9 lane.
 * The reverse steal cannot happen: an E9 never carries the lease header.
 *
 * Everything unrecognized is a BILL — the lane that existed first, handles
 * scanned PDFs with no text layer (extraction yields ~nothing → both sniffs
 * miss → falls through), and has its own provider detection + honest
 * «δεν αναγνωρίστηκε» failure path.
 */
import { fold } from './greekmatch.js';

export type DocClass = 'lease' | 'e9' | 'bill';

/**
 * Fold AND collapse whitespace.
 *
 * `fold()` normalizes accents and case but leaves whitespace alone, and pdfjs
 * builds this text by joining per-item strings — which in this very corpus
 * yields multi-space runs («ΑΡ. ΔΗΛΩΣΗΣ   999532166» in the committed lease
 * fixture, «Ε9   ΒΕΒΑΙΩΣΗ» in the Ε9 one). A space-exact multi-word needle can
 * therefore miss on a kerning or line-break accident while the competing Ε9
 * token — whitespace-free, and legitimately PRESENT in a lease that cites an
 * ΑΤΑΚ — still matches, so the specific marker would lose to the weak one and a
 * μισθωτήριο would be routed to the Ε9 importer. Every other consumer of this
 * text is already whitespace-tolerant (greekleaseparser matches on \s+), so
 * this was the only space-exact matcher in the chain.
 */
function norm(s: string): string {
  return fold(s).replace(/\s+/g, ' ');
}

// Folded + space-collapsed needles — inputs go through the same `norm`, so
// ΜΊΣΘΩΣΗΣ/ΜΙΣΘΩΣΗΣ, tonos-less OCR variants and multi-space runs all match.
const LEASE_HEADER = norm('ΠΛΗΡΟΦΟΡΙΑΚΩΝ ΣΤΟΙΧΕΙΩΝ ΜΙΣΘΩΣΗΣ');
const E9_STRONG = [
  norm('ΒΕΒΑΙΩΣΗ ΥΠΟΒΟΛΗΣ ΔΗΛΩΣΗΣ ΣΤΟΙΧΕΙΩΝ ΑΚΙΝΗΤΩΝ'),
  norm('ΔΗΛΩΘΕΙΣΑΣ ΠΕΡΙΟΥΣΙΑΚΗΣ ΚΑΤΑΣΤΑΣΗΣ'),
  norm('ΣΤΟΙΧΕΙΑ ΑΚΙΝΗΤΩΝ ΠΟΥ ΥΠΑΡΧΟΥΝ ΤΗΝ')
];
// The bare token is accepted only as a WORD («ΕΝΤΥΠΟ Ε9», «ΣΤΟΙΧΕΙΑ Ε9») —
// mirrors buildingmanager's own /Ε9/ marker but bounded, so an RF code or
// billing id containing the substring cannot classify a bill as an E9.
const E9_TOKEN = /(^|[^0-9a-zα-ω])ε9([^0-9a-zα-ω]|$)/;

export function classifyDocumentText(text: string): DocClass {
  const t = norm(text || '');
  if (!t.trim()) return 'bill';
  if (t.includes(LEASE_HEADER)) return 'lease';
  if (E9_STRONG.some((m) => t.includes(m)) || E9_TOKEN.test(t)) return 'e9';
  return 'bill';
}
