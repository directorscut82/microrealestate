# -*- coding: utf-8 -*-
"""Greek spoken-numeral lexicon + grammar for 1..9999, uppercase, accent-tolerant.

Pure Python, stdlib only. Mirrors the token inventory of
jonatasgrosman/wav2vec2-large-xlsr-53-greek (41 chars, UPPERCASE, tonos present).
"""
import itertools
import unicodedata

# --- accent folding -------------------------------------------------------
# The model's vocab.json contains BOTH plain and tonos-bearing uppercase vowels
# (ids 8..14 are Ά Έ Ή Ί Ό Ύ Ώ), so real hypotheses come out either way.
_TONOS = {"Ά": "Α", "Έ": "Ε", "Ή": "Η", "Ί": "Ι", "Ό": "Ο", "Ύ": "Υ", "Ώ": "Ω"}
_UNTONOS = {v: k for k, v in _TONOS.items()}


def fold(s):
    """Strip tonos: ΈΝΑ -> ΕΝΑ. Also normalises final sigma and NFC."""
    s = unicodedata.normalize("NFC", s).upper().replace("Σ", "Σ")
    return "".join(_TONOS.get(c, c) for c in s)


def accent_variants(word):
    """All single-accent placements of an unaccented word + the bare form.

    Greek numerals carry exactly one tonos, but we do not want to hard-code
    which vowel; enumerating every single-vowel placement keeps the lexicon
    robust to the model's (inconsistent) accent behaviour without exploding.
    """
    out = {word}
    for i, c in enumerate(word):
        if c in _UNTONOS:
            out.add(word[:i] + _UNTONOS[c] + word[i + 1 :])
    return out


# --- word inventory (unaccented canonical forms) --------------------------
UNITS = {
    1: ["ΕΝΑ", "ΜΙΑ", "ΕΝΑΣ"],
    2: ["ΔΥΟ"],
    3: ["ΤΡΙΑ", "ΤΡΕΙΣ"],
    4: ["ΤΕΣΣΕΡΑ", "ΤΕΣΣΕΡΙΣ"],
    5: ["ΠΕΝΤΕ"],
    6: ["ΕΞΙ"],
    7: ["ΕΦΤΑ", "ΕΠΤΑ"],
    8: ["ΟΧΤΩ", "ΟΚΤΩ"],
    9: ["ΕΝΝΙΑ", "ΕΝΝΕΑ"],
}
TEENS = {
    10: ["ΔΕΚΑ"],
    11: ["ΕΝΤΕΚΑ", "ΕΝΔΕΚΑ"],
    12: ["ΔΩΔΕΚΑ"],
    13: ["ΔΕΚΑΤΡΙΑ", "ΔΕΚΑΤΡΕΙΣ"],
    14: ["ΔΕΚΑΤΕΣΣΕΡΑ", "ΔΕΚΑΤΕΣΣΕΡΙΣ"],
    15: ["ΔΕΚΑΠΕΝΤΕ"],
    16: ["ΔΕΚΑΕΞΙ"],
    17: ["ΔΕΚΑΕΦΤΑ", "ΔΕΚΑΕΠΤΑ"],
    18: ["ΔΕΚΑΟΧΤΩ", "ΔΕΚΑΟΚΤΩ"],
    19: ["ΔΕΚΑΕΝΝΙΑ", "ΔΕΚΑΕΝΝΕΑ"],
}
TENS = {
    20: ["ΕΙΚΟΣΙ"],
    30: ["ΤΡΙΑΝΤΑ"],
    40: ["ΣΑΡΑΝΤΑ"],
    50: ["ΠΕΝΗΝΤΑ"],
    60: ["ΕΞΗΝΤΑ"],
    70: ["ΕΒΔΟΜΗΝΤΑ"],
    80: ["ΟΓΔΟΝΤΑ"],
    90: ["ΕΝΕΝΗΝΤΑ"],
}
HUNDREDS = {
    100: ["ΕΚΑΤΟ", "ΕΚΑΤΟΝ"],
    200: ["ΔΙΑΚΟΣΙΑ", "ΔΙΑΚΟΣΙΕΣ", "ΔΙΑΚΟΣΙΟΙ"],
    300: ["ΤΡΙΑΚΟΣΙΑ", "ΤΡΙΑΚΟΣΙΕΣ"],
    400: ["ΤΕΤΡΑΚΟΣΙΑ", "ΤΕΤΡΑΚΟΣΙΕΣ"],
    500: ["ΠΕΝΤΑΚΟΣΙΑ", "ΠΕΝΤΑΚΟΣΙΕΣ"],
    600: ["ΕΞΑΚΟΣΙΑ", "ΕΞΑΚΟΣΙΕΣ"],
    700: ["ΕΦΤΑΚΟΣΙΑ", "ΕΠΤΑΚΟΣΙΑ", "ΕΦΤΑΚΟΣΙΕΣ", "ΕΠΤΑΚΟΣΙΕΣ"],
    800: ["ΟΧΤΑΚΟΣΙΑ", "ΟΚΤΑΚΟΣΙΑ", "ΟΧΤΑΚΟΣΙΕΣ", "ΟΚΤΑΚΟΣΙΕΣ"],
    900: ["ΕΝΝΙΑΚΟΣΙΑ", "ΕΝΙΑΚΟΣΙΑ", "ΕΝΙΑΚΟΣΙΕΣ"],
}
THOU1 = ["ΧΙΛΙΑ", "ΧΙΛΙΕΣ"]
THOUN = ["ΧΙΛΙΑΔΕΣ"]

# value classes used by the grammar DFA: word -> (class, value)
CLASS_U, CLASS_TEEN, CLASS_TEN, CLASS_HUND, CLASS_K1, CLASS_KN = (
    "U",
    "TEEN",
    "TEN",
    "HUND",
    "K1",
    "KN",
)


def _expand(words):
    out = set()
    for w in words:
        out |= accent_variants(w)
    return out


def build_word_table():
    """word (any accentuation) -> (class, value). This IS the lexicon."""
    table = {}

    def add(words, cls, val):
        for w in _expand(words):
            table[w] = (cls, val)

    for v, ws in UNITS.items():
        add(ws, CLASS_U, v)
    for v, ws in TEENS.items():
        add(ws, CLASS_TEEN, v)
    for v, ws in TENS.items():
        add(ws, CLASS_TEN, v)
    for v, ws in HUNDREDS.items():
        add(ws, CLASS_HUND, v)
    add(THOU1, CLASS_K1, 1000)
    add(THOUN, CLASS_KN, 1000)
    return table


WORD_TABLE = build_word_table()
LEXICON = sorted(WORD_TABLE)  # ~ a few hundred surface forms


# --- grammar DFA ----------------------------------------------------------
# AMOUNT := THOUS? HUND? TENUNIT?      (>=1 slot filled)
# THOUS  := K1 | U KN
# TENUNIT:= TEEN | TEN U? | U
#
# States: 0 start | 1 saw U (may be thousands-multiplier or final units)
#         2 after thousands | 3 after hundreds | 4 after tens | 5 terminal
_ALLOWED = {
    0: {CLASS_U, CLASS_TEEN, CLASS_TEN, CLASS_HUND, CLASS_K1},
    1: {CLASS_KN},
    2: {CLASS_HUND, CLASS_TEEN, CLASS_TEN, CLASS_U},
    3: {CLASS_TEEN, CLASS_TEN, CLASS_U},
    4: {CLASS_U},
    5: set(),
}
# a state is a valid END state iff the partial parse is a complete amount
_FINAL = {0: False, 1: True, 2: True, 3: True, 4: True, 5: True}


def next_state(state, cls):
    if cls not in _ALLOWED[state]:
        return None
    if state == 0:
        return {CLASS_U: 1, CLASS_TEEN: 5, CLASS_TEN: 4, CLASS_HUND: 3, CLASS_K1: 2}[cls]
    if state == 1:
        return 2
    if state == 2:
        return {CLASS_HUND: 3, CLASS_TEEN: 5, CLASS_TEN: 4, CLASS_U: 5}[cls]
    if state == 3:
        return {CLASS_TEEN: 5, CLASS_TEN: 4, CLASS_U: 5}[cls]
    if state == 4:
        return 5
    return None


def allowed_words(state):
    return {w for w, (c, _) in WORD_TABLE.items() if c in _ALLOWED[state]}


def is_final(state):
    return _FINAL[state]


# --- prefix trie over the lexicon (char-level constraint) -----------------
class PrefixSet:
    """Set of all proper prefixes of the lexicon. Pure Python, O(1) lookup."""

    def __init__(self, words):
        self._p = set()
        for w in words:
            for i in range(len(w) + 1):
                self._p.add(w[:i])

    def __contains__(self, s):
        return s in self._p


PREFIXES = PrefixSet(LEXICON)
# per-state prefix sets so the constraint is grammar-aware, not just lexical
STATE_PREFIXES = {s: PrefixSet(allowed_words(s)) for s in _ALLOWED}


# --- parser: word sequence -> int (or None) -------------------------------
def parse_words(words):
    """Strict left-to-right parse of a token list into 1..9999, else None."""
    state, total, pending_u = 0, 0, None
    for w in words:
        ent = WORD_TABLE.get(w)
        if ent is None:
            return None
        cls, val = ent
        nxt = next_state(state, cls)
        if nxt is None:
            return None
        if cls == CLASS_U:
            if state == 0:
                pending_u = val  # might be a thousands multiplier
            else:
                total += val
        elif cls == CLASS_KN:
            total += pending_u * 1000
            pending_u = None
        elif cls == CLASS_K1:
            total += 1000
        else:
            total += val
        state = nxt
    if not is_final(state):
        return None
    if pending_u is not None:  # a bare unit, never became a multiplier
        total += pending_u
    return total if 1 <= total <= 9999 else None


def _resegment(token, maxparts=3):
    """Greedy longest-match split of a run-together token (PENINTAPENTE)."""
    results = []

    def rec(rest, acc):
        if len(acc) > maxparts:
            return
        if not rest:
            results.append(tuple(acc))
            return
        for ln in range(len(rest), 0, -1):
            head = rest[:ln]
            if head in WORD_TABLE:
                rec(rest[ln:], acc + [head])

    rec(token, [])
    return results


def text_to_int(text):
    """Normalise + parse a decoder hypothesis. Handles the observed
    '-' separator and lost spaces. Returns int or None."""
    t = fold(text).replace("-", " ").replace("'", " ")
    toks = [x for x in t.split() if x]
    if not toks:
        return None
    # fast path
    n = parse_words(toks)
    if n is not None:
        return n
    # slow path: allow each unknown token to be re-segmented
    options = []
    for tok in toks:
        if tok in WORD_TABLE:
            options.append([(tok,)])
        else:
            seg = _resegment(tok)
            if not seg:
                return None
            options.append(seg)
    for combo in itertools.product(*options):
        flat = [w for part in combo for w in part]
        n = parse_words(flat)
        if n is not None:
            return n
    return None


def int_to_words(n):
    """One canonical unaccented spelling, for building the synthetic corpus."""
    assert 1 <= n <= 9999
    out, t, r = [], n // 1000, n % 1000
    if t == 1:
        out.append(THOU1[0])
    elif t >= 2:
        # «χιλιάδες» is FEMININE plural, so 3 and 4 inflect: «τρεις/τέσσερις χιλιάδες»,
        # never «τρία/τέσσερα χιλιάδες» (the ungrammatical form the linguistics review
        # caught in to-words el-GR and in this table's first version). The neuter forms
        # survive as recognition variants via UNITS; the CANONICAL spelling — what the
        # rescorer aligns and what any UI would display — must be the grammatical one.
        FEM = {3: "ΤΡΕΙΣ", 4: "ΤΕΣΣΕΡΙΣ"}
        out.append(FEM.get(t, UNITS[t][0]))
        out.append(THOUN[0])
    h = (r // 100) * 100
    if h:
        out.append(HUNDREDS[h][1] if (h == 100 and r % 100) else HUNDREDS[h][0])
    rest = r % 100
    if rest:
        if rest < 10:
            out.append(UNITS[rest][0])
        elif rest <= 19:
            out.append(TEENS[rest][0])
        else:
            out.append(TENS[(rest // 10) * 10][0])
            if rest % 10:
                out.append(UNITS[rest % 10][0])
    return out
