/**
 * Generate SYNTHETIC ΔΕΗ and ΕΥΔΑΠ bill images (and PDFs) that the real OCR pipeline can
 * read, so the full ingest flow — OCR → card → confirm → δαπάνη → tenant charges — can be
 * exercised end to end without a real customer document.
 *
 * WHY GENERATED. The only real bills available are the landlord's own, which carry their
 * name, address, meter and MARK; this repo is public and those must never be committed
 * (PII_INCIDENT_2026_07_31). Every identifier below is from the reserved synthetic bands:
 * the `999…` ΑΦΜ/παροχή band and the ΟΔΟΣ ΑΛΦΑ/ΒΗΤΑ/ΓΑΜΑ street placeholders. Nothing
 * here corresponds to a real supply, person or address.
 *
 * WHY FOUR. The four scenarios that actually matter in daily use:
 *   deh-1    a first ΔΕΗ bill      → creates a δαπάνη
 *   deh-2    the SAME παροχή again → must find that δαπάνη, post to its own month
 *   eydap-1  a first ΕΥΔΑΠ bill    → creates a δαπάνη (and carries a prior balance)
 *   eydap-2  the SAME account again
 *
 * The layout mimics the real documents' column structure closely enough for the OCR to
 * emit label-runs and value-runs the way a real scan does — that shape is what the parsers
 * are written against, and a naive single-column render would not exercise it.
 */
/* eslint-env node */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const OUT = process.argv[2] || '.fixtures-bills';
fs.mkdirSync(OUT, { recursive: true });

const CSS = `
  @page { size: A4; margin: 0; }
  body { margin: 0; background: #fff; font-family: Arial, Helvetica, sans-serif;
         color: #000; width: 1240px; }
  .pad { padding: 28px 34px; }
  .brand { font-size: 30px; font-weight: 700; letter-spacing: 1px; }
  .sub { font-size: 12px; color: #222; }
  table { border-collapse: collapse; width: 100%; margin-top: 10px; }
  td, th { border: 1px solid #000; padding: 4px 6px; font-size: 13px; text-align: center; }
  th { font-size: 10.5px; font-weight: 600; }
  .lbl { font-size: 11px; }
  .big { font-size: 19px; font-weight: 700; }
  .row { display: flex; gap: 26px; margin-top: 12px; }
  .col { flex: 1; }
  .box { border: 1px solid #000; padding: 8px 10px; margin-top: 10px; }
  .kv { display: flex; justify-content: space-between; font-size: 13px; padding: 2px 0; }
  .addr { font-size: 14px; line-height: 1.5; margin-top: 8px; }
  .mono { font-family: "Courier New", monospace; font-size: 14px; letter-spacing: 1px; }
  /* The παροχή and the payment string must OCR back EXACTLY — a truncated digit is a
     bill attributed to the wrong supply. Courier + letter-spacing lost the «-016» suffix
     off the end of the παροχή (PaddleOCR cut the line box), so identifiers render in plain
     Arial at a size the OCR resolves comfortably, with room to the right. */
  .ident { font-family: Arial, Helvetica, sans-serif; font-size: 20px; font-weight: 600;
           letter-spacing: 0; padding-right: 120px; white-space: nowrap; }
`;

/** ΔΕΗ — the layout the deh parser is written against. */
function deh({ supply, rf, total, periodFrom, periodTo, issue, due, kwh, nextRead }) {
  return `<!doctype html><html lang="el"><head><meta charset="utf-8"><style>${CSS}</style></head>
<body><div class="pad">
  <div class="brand">ΔΕΗ Α.Ε.</div>
  <div class="sub">ΕΞΥΠΗΡΕΤΗΣΗ ΠΕΛΑΤΩΝ ΔΕΗ &nbsp; 800-900-1000 (ΔΩΡΕΑΝ)</div>
  <div class="sub">Α.Φ.Μ. 090000045, Δ.Ο.Υ. ΦΑΕ ΑΘΗΝΩΝ &nbsp; dei.gr</div>

  <div class="addr">
    ΔΟΚΙΜΗ ΚΑΠΠΑ<br/>ΟΔΟΣ ΑΛΦΑ 24<br/>199 47 ΔΟΚΙΜΑΙ
  </div>

  <div class="box">
    <div class="lbl">Κωδικός ηλεκτρονικής πληρωμής</div>
    <div class="mono">${rf}</div>
  </div>

  <table>
    <tr>
      <th>ΠΟΣΟ ΠΛΗΡΩΜΗΣ</th>
      <th>ΕΞΟΦΛΗΣΗ ΕΩΣ</th>
      <th>Τιμολόγιο</th>
    </tr>
    <tr>
      <!-- The ASTERISK is load-bearing, not decoration: the real ΔΕΗ bill prints its
           payable as «*120,00€» and the parser's second amount pattern requires that
           leading asterisk before the digits.
           Rendered without it, the amount was not found at all. -->
      <td class="big">*${total}€</td>
      <td>${due}</td>
      <td>ΓΝ Οικιακό Τιμολόγιο</td>
    </tr>
  </table>

  <div class="box">
    <div class="lbl">Διεύθυνση ακινήτου:</div>
    <div>ΟΔΟΣ ΑΛΦΑ 24, 199 47 ΔΟΚΙΜΑΙ</div>
    <div class="lbl" style="margin-top:6px">Επόμενη καταμέτρηση:</div>
    <div>${nextRead}</div>
  </div>

  <div class="box">
    <div class="lbl">Αριθμός παροχής</div>
    <div class="ident">${supply}</div>
  </div>

  <div class="box">
    <div class="lbl">Η κατανάλωσή σας</div>
    <div class="kv"><span>Κατανάλωση Ηλεκτρικής Ενέργειας</span><span>${kwh} kWh</span></div>
    <div class="kv"><span>Περίοδος κατανάλωσης</span><span>${periodFrom} - ${periodTo}</span></div>
    <div class="kv"><span>Ημερομηνία έκδοσης</span><span>${issue}</span></div>
  </div>

  <div class="box">
    <div class="kv"><span>Χρεώσεις προμήθειας ΔΕΗ</span><span>59,62€</span></div>
    <div class="kv"><span>Ρυθμιζόμενες χρεώσεις</span><span>25,76€</span></div>
    <div class="kv"><span><b>Συνολικό ποσό πληρωμής</b></span><span><b>*${total}€</b></span></div>
  </div>
</div></body></html>`;
}

/**
 * ΕΥΔΑΠ — two header label rows above two value rows, which is what makes the OCR emit
 * label-runs then value-runs. `payable` above `subtotal` is the prior-balance case.
 */
function eydap({
  account, registry, meter, route, tariff, prevRead, currRead, usage, days,
  issue, due, periodFrom, periodTo, docNumber, subtotal, payable, paymentString
}) {
  const tiers = [
    ['14,50', '0,35', '5,08'],
    ['43,50', '0,64', '27,84'],
    ['3,00', '1,83', '5,49']
  ];
  return `<!doctype html><html lang="el"><head><meta charset="utf-8"><style>${CSS}</style></head>
<body><div class="pad">
  <div class="brand" style="text-align:right">ΕΥΔΑΠ</div>
  <div class="sub">ΛΟΓΑΡΙΑΣΜΟΣ ΥΔΡΕΥΣΗΣ ΚΑΙ ΑΠΟΧΕΤΕΥΣΗΣ</div>

  <table>
    <tr>
      <th>Τ.Τ.</th><th>ΑΡΙΘΜΟΣ ΛΟΓΑΡΙΑΣΜΟΥ</th><th>ΔΙΑΔΡΟΜΗ</th><th>ΤΙΜΟΛ.</th>
      <th>ΑΡΙΘΜΟΣ ΜΕΤΡΗΤΗ</th><th>ΑΡΙΘΜΟΣ ΜΗΤΡΩΟΥ</th>
    </tr>
    <tr>
      <td>Α</td><td>${account}</td><td>${route}</td><td>${tariff}</td>
      <td>${meter}</td><td>${registry}</td>
    </tr>
  </table>

  <table>
    <tr>
      <th>ΠΡΟΗΓ. ΕΝΔΕΙΞΗ</th><th>ΤΕΛ. ΕΝΔΕΙΞΗ</th><th>ΚΑΤΑΝΑΛΩΣΗ</th>
      <th>ΗΜΕΡΕΣ ΚΑΤΑΝ.</th><th>ΥΔΡΟΛ.</th><th>ΗΜ/ΝΙΑ ΕΚΔΟΣΗΣ</th>
    </tr>
    <tr>
      <td>${prevRead}</td><td>${currRead}</td><td>${usage}</td>
      <td>${days}</td><td>1</td><td>${issue}</td>
    </tr>
  </table>

  <table>
    <tr>
      <th>ΛΗΞΗ ΠΡΟΘΕΣΜΙΑΣ ΠΛΗΡΩΜΗΣ</th><th>ΠΟΣΟ ΠΛΗΡΩΜΗΣ (ΕΥΡΩ)</th>
      <th>ΠΕΡΙΟΔΟΣ ΚΑΤΑΝΑΛΩΣΗΣ</th><th>ΑΡΙΘΜΟΣ ΠΑΡΑΣΤΑΤΙΚΟΥ</th>
    </tr>
    <tr>
      <td>${due}</td><td>${payable}</td>
      <td>${periodFrom}-${periodTo}</td><td>${docNumber}</td>
    </tr>
  </table>

  <div class="addr">ΔΟΚΙΜΗ ΛΑΜΔΑ<br/>ΟΔΟΣ ΒΗΤΑ 9<br/>11111 ΔΟΚΙΜΑΙ</div>

  <div class="box">
    <div class="lbl">ΑΝΑΛΥΣΗ ΤΙΜΗΜΑΤΟΣ</div>
    ${tiers.map(([v, p, a]) => `<div class="kv"><span>${v}M3 x ${p} €</span><span>${a}</span></div>`).join('')}
  </div>

  <div class="row">
    <div class="col box">
      <div class="lbl">ΤΡΕΧΩΝ ΛΟΓΑΡΙΑΣΜΟΣ (ΕΥΡΩ)</div>
      <div class="kv"><span>ΣΥΝΟΛΟ ΤΙΜΗΜΑΤΟΣ</span><span>38,41</span></div>
      <div class="kv"><span>ΠΑΓΙΟ ΤΕΛΟΣ</span><span>8,70</span></div>
      <div class="kv"><span>ΠΕΡΙΒΑΛΛ. ΤΕΛΟΣ</span><span>0,03</span></div>
      <div class="kv"><span>ΑΠΟΧΕΤΕΥΣΗ 75%</span><span>28,81</span></div>
      <div class="kv"><span>ΦΠΑ ΕΠΙ ΤΙΜΗΜΑΤΟΣ 13%</span><span>4,99</span></div>
      <div class="kv"><span>ΦΠΑ ΕΠΙ ΛΟΙΠΩΝ 24%</span><span>9,00</span></div>
      <div class="kv"><span><b>ΜΕΡΙΚΟ ΣΥΝΟΛΟ (ΕΥΡΩ) :</b></span><span><b>${subtotal}</b></span></div>
    </div>
    <div class="col box">
      <div class="lbl">ΠΡΟΗΓΟΥΜΕΝΕΣ ΟΦΕΙΛΕΣ (ΕΥΡΩ)</div>
      <div class="kv"><span>ΑΠΟ ΛΟΓΑΡΙΑΣΜΟΥΣ</span><span>${
        (Number(payable.replace(',', '.')) - Number(subtotal.replace(',', '.'))).toFixed(2).replace('.', ',')
      }</span></div>
      <div class="kv"><span>ΑΠΟ ΠΡΟΣΑΥΞΗΣΕΙΣ/ΤΟΚΟΥΣ</span><span></span></div>
      <div class="kv"><span><b>ΠΛΗΡΩΤΕΟ(ΕΥΡΩ) :</b></span><span><b>${payable}</b></span></div>
    </div>
  </div>

  <div class="box">
    <div class="lbl">ΑΠΟΚΟΜΜΑ ΤΑΜΕΙΟΥ</div>
    <div class="ident" style="font-size:16px;padding-right:40px">${paymentString}</div>
    <div class="kv"><span>ΠΕΡΙΟΔΟΣ ΚΑΤΑΝΑΛΩΣΗΣ</span><span>${periodFrom}-${periodTo}</span></div>
    <div class="kv"><span>ΤΙΜΟΛΟΓΙΟ</span><span>${tariff}</span></div>
    <div class="kv"><span>ΑΡΙΘΜΟΣ ΜΗΤΡΩΟΥ</span><span>${registry}</span></div>
    <div class="kv"><span>ΚΑΤΑΝΑΛΩΣΗ</span><span>${usage} M3</span></div>
    <div class="kv"><span>ΗΜ/ΝΙΑ ΕΚΔΟΣΗΣ</span><span>${issue}</span></div>
    <div class="kv"><span>ΑΡ. ΠΑΡΑΣΤΑΤΙΚΟΥ</span><span>${docNumber}</span></div>
    <div class="kv"><span>ΗΜ/ΝΙΑ ΛΗΞΕΩΣ</span><span>${due}</span></div>
    <div class="kv"><span><b>ΠΛΗΡΩΤΕΟ</b></span><span><b>${payable}€</b></span></div>
  </div>
</div></body></html>`;
}

// ── the four documents ───────────────────────────────────────────────────────────
// The ΔΕΗ παροχή is shared between deh-1 and deh-2 on purpose: that is scenario 2.
const DEH_SUPPLY = '9 99977001-016';
const EYDAP_ACCOUNT = '99900022233 003';

const DOCS = [
  {
    name: 'deh-1',
    html: deh({
      supply: DEH_SUPPLY,
      rf: 'RF33999000000000000000101',
      total: '84,50',
      periodFrom: '09/05/2026',
      periodTo: '09/06/2026',
      issue: '12/06/2026',
      due: '16/07/2026',
      kwh: '379',
      nextRead: '24/07/2026'
    })
  },
  {
    name: 'deh-2',
    html: deh({
      supply: DEH_SUPPLY, // SAME παροχή — must resolve to the δαπάνη deh-1 created
      rf: 'RF33999000000000000000102',
      total: '91,20',
      periodFrom: '09/06/2026',
      periodTo: '09/07/2026',
      issue: '12/07/2026',
      due: '16/08/2026',
      kwh: '402',
      nextRead: '24/08/2026'
    })
  },
  {
    name: 'eydap-1',
    html: eydap({
      account: EYDAP_ACCOUNT,
      registry: '9990002-33',
      meter: 'A99E77001',
      route: '28',
      tariff: 'B1',
      prevRead: '6000',
      currRead: '6061',
      usage: '61',
      days: '87',
      issue: '04/08/2026',
      due: '01/09/2026',
      periodFrom: '28/04/2026',
      periodTo: '23/07/2026',
      docNumber: '2026 0009 9900 0101 05',
      subtotal: '89,94',
      // PRIOR BALANCE: payable exceeds the subtotal by 200,00 — the arrears case, so the
      // tenant charge must be 89,94 and not 289,94.
      payable: '289,94',
      paymentString: '2026000999000101' + '000028994' + '20260901' + '09990002'
    })
  },
  {
    /**
     * A bill whose PRINTED ΜΕΡΙΚΟ ΣΥΝΟΛΟ disagrees with its own itemised lines.
     *
     * The other four fixtures are internally consistent, so none of them can make the
     * parser emit 'breakdown-does-not-sum-to-subtotal' or the override code — which meant
     * the amber rows those codes drive could not be LOOKED AT on the real screen at all. A
     * surface no fixture can reach is a surface nobody has reviewed.
     *
     * The six lines are untouched and sum to 89,94; the printed subtotal is 20,00 higher,
     * which is what an unknown seventh levy looks like. The parser must charge the LOWER
     * figure and say on the card that it did.
     */
    name: 'eydap-mismatch',
    html: eydap({
      account: '99900022244 004',
      registry: '9990002-44',
      meter: 'A99E77002',
      route: '28',
      tariff: 'B1',
      prevRead: '7000',
      currRead: '7061',
      usage: '61',
      days: '87',
      issue: '04/08/2026',
      due: '01/09/2026',
      periodFrom: '28/04/2026',
      periodTo: '23/07/2026',
      docNumber: '2026 0009 9900 0303 05',
      subtotal: '109,94',
      payable: '109,94',
      paymentString: '2026000999000303' + '000010994' + '20260901' + '09990002'
    })
  },
  {
    name: 'eydap-2',
    html: eydap({
      account: EYDAP_ACCOUNT, // SAME account — scenario 4
      registry: '9990002-33',
      meter: 'A99E77001',
      route: '28',
      tariff: 'B1',
      prevRead: '6061',
      currRead: '6135',
      usage: '74',
      days: '91',
      issue: '05/11/2026',
      due: '02/12/2026',
      periodFrom: '24/07/2026',
      periodTo: '22/10/2026',
      docNumber: '2026 0009 9900 0202 05',
      subtotal: '89,94',
      payable: '89,94', // no arrears this time
      paymentString: '2026000999000202' + '000008994' + '20261202' + '09990002'
    })
  }
];

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1240, height: 1754 },
  // 2x so the OCR sees crisp glyphs — a 1x render of 11px Greek text is at the edge of
  // what PaddleOCR resolves, and a fixture the OCR cannot read tests nothing.
  deviceScaleFactor: 2
});
for (const d of DOCS) {
  await page.setContent(d.html, { waitUntil: 'load' });
  await page.screenshot({
    path: path.join(OUT, `${d.name}.png`),
    fullPage: true
  });
  await page.pdf({ path: path.join(OUT, `${d.name}.pdf`), format: 'A4', printBackground: true });
  console.log('wrote', d.name + '.png', '+', d.name + '.pdf');
}
await browser.close();
fs.writeFileSync(
  path.join(OUT, 'ids.json'),
  JSON.stringify({ dehSupply: DEH_SUPPLY, eydapAccount: EYDAP_ACCOUNT }, null, 2)
);
console.log('\nshared ids:', DEH_SUPPLY, '|', EYDAP_ACCOUNT);
