import { t, gloss, type GlossaryTerm, type MessageKey } from '../core/i18n/index.js';

/**
 * How to play: what the village is for, how its work gets done, and what the words mean.
 *
 * The controls card answers "which key", and it was the only guide the game had. A
 * player who has never heard of an umgodi cannot get from "1-3 build" to why they would
 * want one, and the game is played in terms — isibaya, umuzi, isiziba — that are glossed
 * nowhere a player can reach. This is the place they are.
 *
 * A native `<dialog>`: it traps focus, closes on Escape and restores focus to whatever
 * opened it, all of which is exactly the accessibility work a hand-rolled modal gets
 * subtly wrong.
 */

export interface HelpHandlers {
  /** The guide opened. The game pauses while it is read. */
  onOpen(): void;
  /** The guide closed. */
  onClose(): void;
}

export interface Help {
  readonly button: HTMLButtonElement;
  readonly isOpen: () => boolean;
  open(): void;
  close(): void;
}

/** Sections of prose, in the order a new player needs them. */
const SECTIONS: readonly { readonly heading: MessageKey; readonly body: MessageKey }[] = [
  { heading: 'help.goal.heading', body: 'help.goal.body' },
  { heading: 'help.people.heading', body: 'help.people.body' },
  { heading: 'help.food.heading', body: 'help.food.body' },
  { heading: 'help.seasons.heading', body: 'help.seasons.body' },
  { heading: 'help.cattle.heading', body: 'help.cattle.body' },
  { heading: 'help.wild.heading', body: 'help.wild.body' },
  { heading: 'help.timber.heading', body: 'help.timber.body' },
  { heading: 'help.land.heading', body: 'help.land.body' },
  { heading: 'help.neighbours.heading', body: 'help.neighbours.body' },
];

/** The controls, as the reference card groups them, plus the camera the card leaves out. */
const CONTROLS: readonly MessageKey[] = [
  'help.camera',
  'controls.select',
  'controls.build',
  'controls.land',
  'controls.groups',
  'controls.time',
];

/**
 * The words the game is played in, each with its gloss.
 *
 * Proper nouns and material-culture terms are not translated (docs/CONTENT.md), which
 * makes the gloss the only way a player learns them — so every one the game puts on a
 * button is here.
 */
const TERMS: readonly GlossaryTerm[] = [
  'umuzi',
  'isibaya',
  'isibayaSezimbuzi',
  'umgodi',
  'isiziba',
  'indlunkulu',
  'ikhanda',
  'amabutho',
  'umkhosi',
  'umzingeli',
  'drift',
];

/** How each term is written in the game, since the glossary keys are identifiers. */
const TERM_LABELS: Readonly<Partial<Record<GlossaryTerm, MessageKey>>> = {
  umuzi: 'building.umuzi',
  isibaya: 'building.isibaya',
  isibayaSezimbuzi: 'building.isibayaSezimbuzi',
  umgodi: 'building.umgodi',
  isiziba: 'building.isiziba',
  indlunkulu: 'building.indlunkulu',
  ikhanda: 'building.ikhanda',
  amabutho: 'tech.amabutho',
  umkhosi: 'tech.umkhosi',
  drift: 'help.driftTerm',
  umzingeli: 'help.umzingeliTerm',
};

function paragraphs(parent: HTMLElement, key: MessageKey): void {
  for (const line of t(key).split('\n')) {
    if (line.trim() === '') continue;
    const p = document.createElement('p');
    p.textContent = line;
    parent.append(p);
  }
}

export function createHelp(parent: HTMLElement, handlers: HelpHandlers): Help {
  const button = document.createElement('button');
  button.className = 'help-button';
  button.textContent = t('help.button');
  button.dataset.tip = t('help.buttonHint');
  button.setAttribute('aria-haspopup', 'dialog');

  const dialog = document.createElement('dialog');
  dialog.className = 'help';
  dialog.setAttribute('aria-labelledby', 'help-title');

  const header = document.createElement('div');
  header.className = 'help__header';
  const title = document.createElement('h2');
  title.id = 'help-title';
  title.textContent = t('help.title');
  const close = document.createElement('button');
  close.className = 'help__close';
  close.textContent = t('help.close');
  close.dataset.tip = t('help.closeHint');
  close.addEventListener('click', () => dialog.close());
  header.append(title, close);

  const body = document.createElement('div');
  body.className = 'help__body';

  const intro = document.createElement('div');
  intro.className = 'help__intro';
  paragraphs(intro, 'help.intro');
  body.append(intro);

  for (const section of SECTIONS) {
    const block = document.createElement('section');
    const heading = document.createElement('h3');
    heading.textContent = t(section.heading);
    block.append(heading);
    paragraphs(block, section.body);
    body.append(block);
  }

  const controls = document.createElement('section');
  const controlsHeading = document.createElement('h3');
  controlsHeading.textContent = t('help.controlsHeading');
  const controlList = document.createElement('ul');
  for (const key of CONTROLS) {
    const item = document.createElement('li');
    item.textContent = t(key);
    controlList.append(item);
  }
  controls.append(controlsHeading, controlList);
  body.append(controls);

  const words = document.createElement('section');
  const wordsHeading = document.createElement('h3');
  wordsHeading.textContent = t('help.wordsHeading');
  const list = document.createElement('dl');
  list.className = 'help__terms';
  for (const term of TERMS) {
    const name = document.createElement('dt');
    name.textContent = t(TERM_LABELS[term] ?? 'help.title');
    const meaning = document.createElement('dd');
    meaning.textContent = gloss(term);
    list.append(name, meaning);
  }
  words.append(wordsHeading, list);
  body.append(words);

  dialog.append(header, body);
  parent.append(button, dialog);

  // Clicking the backdrop closes it: the dialog element itself is the backdrop's
  // target, since every click on the content lands on a child.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => handlers.onClose());
  // Keys pressed while reading are the reader's, not the game's.
  dialog.addEventListener('keydown', (event) => event.stopPropagation());

  function open(): void {
    if (dialog.open) return;
    dialog.showModal();
    body.scrollTop = 0;
    handlers.onOpen();
  }

  button.addEventListener('click', open);

  return {
    button,
    isOpen: () => dialog.open,
    open,
    close: () => dialog.close(),
  };
}
