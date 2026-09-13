# Content and terminology policy

The chosen framing is **grounded but playable**: real polities, correct orthography,
historically plausible units and tactics, with gameplay-driven simplification acknowledged
rather than hidden.

This document exists because naming decisions in this project are not `t()` calls. They are
editorial positions, and making them ad hoc during implementation produces an incoherent
result that is expensive to unpick once it is in a hundred string keys.

---

## 1. The period, and what is contested about it

The game is set in southern Africa roughly 1815-1840: a period of widespread warfare,
state formation and mass displacement.

**Even the name is a choice.** *Mfecane* is the isiZulu-derived term; *Difaqane* (Sesotho,
also *Lifaqane*) is used for the same period on the highveld. Using one exclusively
centres one people's experience of the period.

The **causes are actively contested historiography**, not settled fact. The long-standing
popular narrative attributes the upheaval primarily to the expansion of the Zulu kingdom
under Shaka. Julian Cobbing's 1988 article *"The Mfecane as Alibi"* argued that this
framing functioned as an alibi — that European slave-raiding and labour demand, and the
violence of the Cape frontier, were displaced onto an invented picture of self-generated
African savagery, which in turn helped justify colonial land seizure. Cobbing's specific
claims drew substantial critique (Elizabeth Eldredge among others), and the current
scholarly picture is multi-causal: drought and ecological stress, competition over the
ivory and slave trade routes through Delagoa Bay, Cape frontier raiding, and internal
processes of state formation all contribute.

**Position for this project.** We do not adopt the Shaka-as-sole-cause narrative. Drought
is already a mechanic; trade pressure and raiding should be too. Where the game simplifies —
and an RTS must — the documentation says so plainly rather than presenting game logic as
history. A short in-game or repo-level historical note should state the dispute and point
to real scholarship.

**This is a live subject with descendant communities.** Cultural consultation is a line
item, not a localization-time afterthought. Budget it before art is commissioned and before
faction flavour text is written, because both are expensive to redo.

---

## 2. Translation rule

**Proper nouns and material-culture terms are not translated. They are glossed.**

This is the rule the original brief had no position on, and it matters because the brief's
"zero hardcoded UI strings" goal will otherwise push content terminology into the
translation layer, where it does not belong.

| Category | Treatment | Example |
|---|---|---|
| Polity and people names | Never translated | *amaZulu*, *Basotho* |
| Material culture, weapons, structures | Never translated; glossed on first use and in a codex entry | *iklwa*, *isibaya* |
| Ranks and social units | Never translated; glossed | *impi* |
| Place names | Never translated | *Thaba Bosiu* |
| UI chrome, verbs, numbers, tooltips | Always through `t()` | "Build", "Attack Move" |

Practically: `t('unit.impi.name')` resolves to `"impi"` in **every** locale. The gloss is a
separate key that does translate. A locale file that renders *impi* as "regiment" is a bug.

---

## 3. Orthography

Southern African Bantu languages use noun-class prefixes. Getting these wrong is the most
visible marker of a carelessly researched game.

- **isiZulu:** *amaZulu* (the people), *isiZulu* (the language), *KwaZulu* (the place).
  Prefixes are lowercase mid-sentence; the stem carries the capital. So **`amaZulu`, not
  `AmaZulu`** — the brief's capitalization is wrong, and it is wrong in the same way for
  `AmaNdebele` (correct: *amaNdebele*).
- **Sesotho:** *Basotho* (the people), *Sesotho* (the language), *Lesotho* (the country).
  **`Basotho`, not `BaSotho`** — there is no internal capital.
- **Griqua** is a European-alphabet exonym-turned-endonym and takes ordinary capitalization.
  It was adopted around 1813, replacing the imposed term *Bastaards*. Do not use the earlier
  term anywhere, including in historical flavour text.

Faction identifiers in code should be stable ASCII slugs (`zulu`, `sotho`, `ndebele`,
`griqua`); the display name comes from the locale file with correct orthography and
diacritics. This is also why the HUD is DOM rather than Pixi text — see
`ARCHITECTURE.md` §10.

**Items from the brief to verify before use:**

- The beehive grass hut is **iQhugwane** in most sources; the brief writes "iQukwane".
  Verify before it enters a string key.
- **iklwa** as the name of the short stabbing spear is widely repeated but its historicity
  is debated; *assegai* is a generic Portuguese-derived term. Decide and document which the
  game uses.
- **knobkerrie** is from Afrikaans *knopkierie*. The isiZulu term is *iwisa*. See §4.

---

## 4. Register: whose words describe the land

A subtle but real trap. Much of the standard South African landscape vocabulary is
Afrikaans or Dutch in origin:

*kraal, koppie, donga, veld, sourveld, thornveld, drift, poort, kloof, Drakensberg, Karoo*
(from Khoekhoe via Afrikaans).

A game about amaZulu and Basotho polities that names every hill, gully and cattle enclosure
in Afrikaans has quietly adopted the settler gaze, no matter how accurate each individual
term is.

**Policy:** use the language of the people whose land it is for anything inside their
territory, and gloss with the familiar term where players need the handhold.

- Cattle enclosure: **isibaya** (isiZulu), not *kraal*. Homestead: **umuzi**.
- The mountain range: **uKhahlamba** (isiZulu) / **Maloti** (Sesotho), glossed as
  Drakensberg.
- The river: **uMfolozi** — note the prefix; the brief's "Umfolozi" drops it.

Afrikaans terms remain correct and appropriate for Griqua content and for the Karoo, which
is genuinely their linguistic register. The point is deliberateness, not blanket avoidance.

---

## 5. Depiction limits

The period involved real mass death, displacement and famine affecting identifiable
ancestors of living people. Ordinary RTS abstraction — units, hit points, resource yields —
is fine; that is the genre. The lines:

- No fictional atrocities attributed to real named people.
- Civilian populations are not a resource to be harvested.
- Famine and drought are systemic pressures, not player-directed weapons against
  civilians.
- Faction flavour text describes political and economic aims, not racial or moral
  character. No noble-savage framing, and no "civilizing" framing for the Griqua on account
  of firearms and horses.

---

## 6. Localization scope

`en` only until the UI settles. Shipping a second locale while copy churns wastes
translation effort on strings that will not survive.

The lint rule banning hardcoded strings applies **from commit one** regardless — that part
is genuinely expensive to retrofit, which is why the original brief was right to put i18n
in Phase 1 even though the translation work itself waits.

isiZulu and Sesotho localizations, if they happen, should be done by speakers, not by
machine translation, and would be the natural moment for the consultation in §1.
