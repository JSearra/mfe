import { BUILDINGS, BuildingType, buildingSpec } from '../shared/buildings/index.js';
import { TECHS, TECH_IDS, TechId } from '../shared/tech/index.js';
import { Resource } from '../shared/resources.js';
import { t, type MessageKey } from '../core/i18n/index.js';
import { summariseSelection, SummaryRole } from './selectionSummary.js';
import {
  buildAvailability,
  researchAvailability,
  trainAvailability,
  Refusal,
  type Purse,
} from './availability.js';
import type { InterpolatedView } from '../render/interpolation.js';
import type { TradeOffer } from '../sim/trade.js';
import type { Relation } from '../sim/alliance.js';

/** Resource -> its name. Keyed by the enum, so a new resource without a name is a compile error. */
const RESOURCE_KEYS: Readonly<Record<Resource, MessageKey>> = {
  [Resource.Cattle]: 'resource.cattle',
  [Resource.Grain]: 'resource.grain',
  [Resource.Wood]: 'resource.wood',
  [Resource.Meat]: 'resource.meat',
  [Resource.Skins]: 'resource.skins',
  [Resource.Ivory]: 'resource.ivory',
  [Resource.Water]: 'resource.water',
};

/**
 * The command bar: who the village has, what is selected, and what can be done.
 *
 * It was a single card in the bottom-left corner that grew upward with everything the
 * village could do — eight buildings, five advances, six trades, the ration, the cull,
 * the ties — until it ran off the screen and under the controls card. Worse, building
 * only appeared once somebody was selected, although a site needs nobody to place it,
 * and nothing anywhere said how many people the village had or what they were doing.
 *
 * So it is a bar along the bottom in three parts, read left to right in the order a
 * player asks: who have I got (people, by what they are doing, each a click away from
 * being selected), what have I got hold of (the selection and its orders), and what
 * can the village do (building, its own decisions, its neighbours — one tab each, so
 * none of them pushes the others off the screen).
 *
 * It is DOM, like the rest of the HUD, for the reasons in ARCHITECTURE section 10:
 * free text shaping for diacritic-heavy isiZulu and Sesotho, accessibility, and far less
 * code than drawing buttons in Pixi.
 */

/** What a household costs, by movement class, as the host reports it. */
export type TrainCosts = readonly { readonly grain: number; readonly cattle: number }[];

/** Role -> the line that describes it. Keyed by the enum, so a new role is a compile error. */
const ROLE_KEYS: Readonly<Record<SummaryRole, MessageKey>> = {
  [SummaryRole.None]: 'role.none',
  [SummaryRole.Herder]: 'role.herder',
  [SummaryRole.FieldHand]: 'role.fieldHand',
  [SummaryRole.Carrier]: 'role.carrier',
  [SummaryRole.Elder]: 'role.elder',
  [SummaryRole.Hunter]: 'role.hunter',
  [SummaryRole.Injured]: 'role.injured',
  [SummaryRole.WaterCarrier]: 'role.water',
  [SummaryRole.Builder]: 'role.builder',
  [SummaryRole.Busy]: 'role.busy',
};

/**
 * The order the people are listed in. Fixed, so a count that falls to zero does not
 * move every row below it — the player learns where "idle" is and it stays there.
 * Idle first because it is the row a player acts on; the injured last because nothing
 * can be done with them.
 */
const PEOPLE_ORDER: readonly SummaryRole[] = [
  SummaryRole.None,
  SummaryRole.FieldHand,
  SummaryRole.Builder,
  SummaryRole.Herder,
  SummaryRole.WaterCarrier,
  SummaryRole.Hunter,
  SummaryRole.Carrier,
  SummaryRole.Elder,
  SummaryRole.Busy,
  SummaryRole.Injured,
];

/**
 * What each building is FOR, in a sentence. Keyed by the enum, so a new building without
 * one is a compile error rather than a button whose tooltip only knows the price.
 */
const BUILDING_INFO: Readonly<Record<BuildingType, MessageKey>> = {
  [BuildingType.Isibaya]: 'buildingInfo.isibaya',
  [BuildingType.Umuzi]: 'buildingInfo.umuzi',
  [BuildingType.GrainStore]: 'buildingInfo.grainStore',
  [BuildingType.Ikhanda]: 'buildingInfo.ikhanda',
  [BuildingType.Indlunkulu]: 'buildingInfo.indlunkulu',
  [BuildingType.Umgodi]: 'buildingInfo.umgodi',
  [BuildingType.Isiziba]: 'buildingInfo.isiziba',
  [BuildingType.IsibayaSezimbuzi]: 'buildingInfo.isibayaSezimbuzi',
  [BuildingType.HuntersCamp]: 'buildingInfo.huntersCamp',
  [BuildingType.Well]: 'buildingInfo.well',
};

/** The same for each advance. */
const TECH_INFO: Readonly<Record<TechId, MessageKey>> = {
  [TechId.Amabutho]: 'techInfo.amabutho',
  [TechId.Umkhosi]: 'techInfo.umkhosi',
  [TechId.ScoutingParties]: 'techInfo.scoutingParties',
  [TechId.CattleLore]: 'techInfo.cattleLore',
  [TechId.MountedCommando]: 'techInfo.mountedCommando',
};

const KIND_UNIT = 0;
const KIND_BUILDING = 2;
const MOVEMENT_INFANTRY = 0;

export interface CommandPanelHandlers {
  onTrain(buildingHandle: number, movementClass: number): void;
  onArmBuild(type: BuildingType): void;
  onResearch(techIndex: number): void;
  onTrade(partner: number, offered: number, wanted: number, amount: number): void;
  onAlly(partner: number): void;
  onBreak(partner: number): void;
  onCull(): void;
  /** Put the village on short commons, or take it off them. */
  onRation(short: boolean): void;
  /** Take down a building of the player's own. */
  onDemolish(buildingHandle: number): void;
  /** Select everyone doing one thing. `additive` adds them to what is already held. */
  onSelectRole(role: SummaryRole, additive: boolean): void;
  /** Pick up the tool that breaks ground for a field. */
  onPlant(): void;
  /** Arm a patrol for the next order click. */
  onPatrol(): void;
}

export interface CommandPanelOptions {
  /** Whose people the bar counts. */
  readonly player: number;
  /** Building -> the key that picks it up, for the buildings that have one. */
  readonly buildKeys: Readonly<Partial<Record<BuildingType, string>>>;
}

/**
 * The field under the pointer, as it last crossed the boundary.
 *
 * Fields are not selectable, so the panel reads the one being pointed at whenever
 * nothing is selected. A field asks for hands now (src/sim/labour.ts), and whether it is
 * getting them is the single thing about it a player most needs to know.
 */
export interface FieldReading {
  readonly condition: number;
  readonly established: boolean;
  readonly resting: boolean;
  readonly hands: number;
  readonly wanted: number;
}

export interface CommandPanel {
  readonly element: HTMLElement;
  update(
    view: InterpolatedView | null,
    selected: ReadonlySet<number>,
    field?: FieldReading | null,
  ): void;
  /** Hands a building site asks for, as the simulation reckons it. */
  setSiteHands(hands: number): void;
  /**
   * What to call each village, by player index — the people it is, where known.
   *
   * The rows said "Village 2". The neighbour is a people with a name the setup screen
   * chose (ADR-0021: a trade screen and a party to ties, so the name is most of what the
   * player knows of it). Falls back to the numbered form for any index not given.
   */
  setVillageNames(names: readonly string[]): void;
  /**
   * What the neighbours will trade, and at what rate.
   *
   * On the Neighbours tab rather than under a selection, because trade belongs to the
   * village rather than to whatever happens to be selected — and because the rate is
   * news: it is the only window a player has onto what a neighbour is short of.
   */
  setOffers(offers: readonly TradeOffer[]): void;
  /**
   * The neighbours, and where this village stands with each.
   *
   * Beside the trade rows, because the two are the same conversation: standing sets the
   * rate, so a player who wonders why an offer got worse can see the reason without
   * leaving the tab.
   */
  setRelations(relations: readonly Relation[]): void;
  /** How many head a slaughter would take, as the simulation reckons it. Zero hides it. */
  setHerd(head: number): void;
  /**
   * What the village is eating, and the switch for it.
   *
   * On the Village tab beside the cull, because neither is a thing a villager does —
   * they are both the village deciding something about itself. Always shown, so a bad
   * year does not have to be survived once before the move is discovered.
   */
  setRation(short: boolean, hungry: boolean): void;
  /**
   * What the village holds and knows, so the actions can say why they are unavailable.
   *
   * Set separately from `update` because it changes on its own clock — the balance
   * moves every upkeep and the selection does not. It repaints the buttons in place
   * rather than replacing them, so a change of purse never discards the button the
   * player is mid-click on.
   */
  setPurse(purse: Purse, techStatus: readonly number[], trainCosts: TrainCosts): void;
  /**
   * What the next click will do, so the button that armed it can say so.
   *
   * A building picked up from a hotkey was invisible: the cursor grew a footprint and
   * nothing anywhere said what it was or how to put it down.
   */
  setTool(armed: BuildingType | null, planting: boolean, patrolling: boolean): void;
}

/**
 * A bar button, with what it does on a slow tooltip.
 *
 * `data-tip` rather than `title`: see ui/tooltip.ts. The hint is the explanation a
 * player asked for by stopping on the button, so it is written as one.
 */
function button(label: string, hint: string, onClick: (event: MouseEvent) => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'panel__button';
  element.textContent = label;
  element.dataset.tip = hint;
  element.addEventListener('click', (event) => {
    onClick(event);
    // Give the keyboard back. A button that keeps focus after a click takes the next
    // Space or Enter for itself — Space jumps to an alert, and pressing a trade again
    // because the player wanted to see a stampede is not a mistake they made.
    element.blur();
  });
  return element;
}

/** The key that does the same thing, printed on the button, where there is one. */
function keyBadge(key: string): HTMLElement {
  const badge = document.createElement('kbd');
  badge.className = 'panel__key';
  badge.textContent = key;
  return badge;
}

/** Refusal -> the string that explains it, and which cost it is about. */
const REFUSAL_KEYS: Readonly<Record<Refusal, MessageKey | null>> = {
  [Refusal.None]: null,
  [Refusal.Grain]: 'refusal.grain',
  [Refusal.Wood]: 'refusal.wood',
  [Refusal.Cattle]: 'refusal.cattle',
  [Refusal.NeedsWater]: 'refusal.needsWater',
  [Refusal.Unfinished]: 'refusal.unfinished',
  [Refusal.QueueFull]: 'refusal.queueFull',
  [Refusal.AlreadyKnown]: 'refusal.alreadyKnown',
  [Refusal.InProgress]: 'refusal.inProgress',
};

/** What something costs. */
interface Price {
  readonly grain: number;
  readonly wood: number;
  readonly cattle: number;
}

/** Each part of a price, and its phrase. "0 cattle" is noise on a button face, so it is left out. */
const PRICE_PARTS: readonly (readonly [keyof Price, MessageKey])[] = [
  ['grain', 'resource.amount.grain'],
  ['wood', 'resource.amount.wood'],
  ['cattle', 'resource.amount.cattle'],
];

function priceText(price: Price): string {
  const parts = PRICE_PARTS.filter(([part]) => price[part] > 0).map(([part, key]) =>
    t(key, { n: price[part] }),
  );
  return parts.length === 0 ? t('panel.free') : parts.join(' · ');
}

/**
 * Refusals that are about the price. The button face already shows the price, with the
 * part the village is short of lit, so these need no sentence on the face as well —
 * the sentence is on the tooltip. Every other refusal is not visible in the price and
 * has to be said.
 */
const PRICE_REFUSALS: ReadonlySet<Refusal> = new Set([Refusal.Grain, Refusal.Wood, Refusal.Cattle]);

/**
 * A button that says why it cannot be pressed, instead of accepting the click and
 * doing nothing — and keeps saying it as the purse changes, without being replaced.
 *
 * NOT disabled. A greyed-out control with a reason on it is readable; a dead one teaches
 * nothing, and the player has to discover by hovering that there was ever an
 * explanation. `NeedsWater` in particular stays live: the refusal is about WHERE, and
 * the player finds out by trying to site it, which is the gesture that teaches the rule.
 */
interface Action {
  readonly element: HTMLButtonElement;
  /** Say why it cannot be had, and light each part of the price the purse falls short of. */
  refuse(refusal: Refusal, reason: string, purse: Purse): void;
}

function action(
  label: string,
  about: string,
  price: Price,
  key: string | undefined,
  onClick: () => void,
): Action {
  const element = button('', '', onClick);
  element.classList.add('panel__button--action');
  const name = document.createElement('span');
  name.className = 'panel__name';
  name.textContent = label;
  if (key !== undefined) name.append(keyBadge(key));

  // One span a part, each unbreakable, so a price that wraps does so between "55
  // timber" and "2 cattle" and never between "2" and "cattle".
  const cost = document.createElement('span');
  cost.className = 'panel__cost';
  const parts = new Map<keyof Price, HTMLElement>();
  for (const [part, phrase] of PRICE_PARTS) {
    if (price[part] <= 0) continue;
    const span = document.createElement('span');
    span.textContent = t(phrase, { n: price[part] });
    parts.set(part, span);
    cost.append(span);
  }
  if (parts.size === 0) cost.textContent = t('panel.free');

  const why = document.createElement('span');
  why.className = 'panel__why';
  element.append(name, cost, why);

  // Name, what it is for, what it costs, and — last, because it is the part that
  // changes — why it cannot be had yet.
  const tip = [label, about, t('tip.costs', { costs: priceText(price) })];
  let shownKey = '';
  return {
    element,
    refuse(refusal, reason, purse): void {
      const short = PRICE_PARTS.map(([part]) => (purse[part] < price[part] ? 1 : 0)).join('');
      const next = `${refusal}|${reason}|${short}`;
      if (next === shownKey) return;
      shownKey = next;
      const refused = refusal !== Refusal.None;
      element.classList.toggle('is-refused', refused);
      for (const [part, span] of parts) span.classList.toggle('is-short', purse[part] < price[part]);
      why.textContent = PRICE_REFUSALS.has(refusal)
        ? ''
        : refusal === Refusal.NeedsWater
          ? t('panel.byWater')
          : reason;
      element.dataset.tip = (refused ? [...tip, reason] : tip).join('\n');
    },
  };
}

/** A section of the bar, with its small capitals heading. */
function section(className: string, title?: HTMLElement): HTMLElement {
  const element = document.createElement('section');
  element.className = `bar__section ${className}`;
  if (title !== undefined) element.append(title);
  return element;
}

function heading(text = ''): HTMLElement {
  const element = document.createElement('div');
  element.className = 'panel__heading';
  element.textContent = text;
  return element;
}

const TAB_BUILD = 0;
const TAB_VILLAGE = 1;
const TAB_NEIGHBOURS = 2;

export function createCommandPanel(
  parent: HTMLElement,
  handlers: CommandPanelHandlers,
  options: CommandPanelOptions,
): CommandPanel {
  const element = document.createElement('div');
  element.className = 'bar';
  // Right-click is an order on the map. On the bar it means nothing, and the browser's
  // own menu over the game is the one thing it must not open.
  element.addEventListener('contextmenu', (event) => event.preventDefault());

  // ---- People: who the village has, by what they are doing. ----

  const peopleHeading = heading();
  const people = section('bar__people', peopleHeading);
  const roleGrid = document.createElement('div');
  roleGrid.className = 'bar__roles';
  const roleButtons = new Map<SummaryRole, HTMLButtonElement>();
  for (const role of PEOPLE_ORDER) {
    const row = button('', t('panel.people.selectHint'), (event) =>
      handlers.onSelectRole(role, event.shiftKey),
    );
    row.classList.add('bar__role');
    if (role === SummaryRole.None) row.classList.add('bar__role--idle');
    roleButtons.set(role, row);
    roleGrid.append(row);
  }
  people.append(roleGrid);

  // ---- The selection: what is held, and what it can be told. ----

  const selectionHeading = heading();
  const selection = section('bar__selection', selectionHeading);
  const detail = document.createElement('div');
  detail.className = 'panel__detail';
  const actions = document.createElement('div');
  actions.className = 'panel__actions';
  // How to give an order, under the orders that have buttons: right-click is the one
  // gesture the bar cannot put a button on, so it is written down beside them.
  const how = document.createElement('div');
  how.className = 'panel__how';
  selection.append(detail, actions, how);

  // ---- What the village can do, a tab each. ----

  const tabs = section('bar__tabs');
  const tabList = document.createElement('div');
  tabList.className = 'bar__tablist';
  tabList.setAttribute('role', 'tablist');
  const tabBodies: HTMLElement[] = [];
  const tabButtons: HTMLButtonElement[] = [];

  function showTab(index: number): void {
    tabButtons.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === index));
      tab.classList.toggle('is-active', i === index);
    });
    tabBodies.forEach((body, i) => {
      body.hidden = i !== index;
    });
  }

  for (const [index, key] of [
    [TAB_BUILD, 'panel.tabs.build'],
    [TAB_VILLAGE, 'panel.tabs.village'],
    [TAB_NEIGHBOURS, 'panel.tabs.neighbours'],
  ] as const) {
    const tab = button(t(key), t(`${key}Hint` as MessageKey), () => showTab(index));
    tab.className = 'bar__tab';
    tab.setAttribute('role', 'tab');
    tabButtons.push(tab);
    tabList.append(tab);
    const body = document.createElement('div');
    body.className = 'bar__tabbody';
    body.setAttribute('role', 'tabpanel');
    tabBodies.push(body);
  }
  tabs.append(tabList, ...tabBodies);

  // Build: every building, always. Placing a site needs nobody selected — work near a
  // homestead finds its own people — so hiding the list behind a selection hid building.
  const buildGrid = document.createElement('div');
  buildGrid.className = 'bar__grid';
  const buildActions = new Map<BuildingType, Action>();
  for (const spec of Object.values(BUILDINGS)) {
    const built = action(
      t(spec.nameKey as MessageKey),
      `${t(BUILDING_INFO[spec.type])}\n${t('panel.buildHint')}`,
      { grain: spec.grainCost, wood: spec.woodCost, cattle: spec.cattleCost },
      options.buildKeys[spec.type],
      () => handlers.onArmBuild(spec.type),
    );
    buildActions.set(spec.type, built);
    buildGrid.append(built.element);
  }
  tabBodies[TAB_BUILD]!.append(buildGrid);

  // Village: the decisions the village makes about itself — what it eats, what it
  // slaughters, what it learns.
  const ration = document.createElement('div');
  ration.className = 'bar__row';
  const herd = document.createElement('div');
  herd.className = 'bar__row';
  const researchHeading = heading(t('panel.researchHeading'));
  researchHeading.classList.add('panel__heading--sub');
  const researchGrid = document.createElement('div');
  researchGrid.className = 'bar__grid';
  const researchActions: Action[] = [];
  for (let i = 0; i < TECH_IDS.length; i++) {
    const spec = TECHS[TECH_IDS[i] as TechId];
    const learned = action(
      t(spec.nameKey as MessageKey),
      `${t(TECH_INFO[TECH_IDS[i] as TechId])}\n${t('panel.researchHint')}`,
      { grain: spec.grainCost, wood: 0, cattle: spec.cattleCost },
      undefined,
      () => handlers.onResearch(i),
    );
    researchActions.push(learned);
    researchGrid.append(learned.element);
  }
  const villageTop = document.createElement('div');
  villageTop.className = 'bar__row';
  villageTop.append(ration, herd);
  tabBodies[TAB_VILLAGE]!.append(villageTop, researchHeading, researchGrid);

  // Neighbours: standing first, because it sets the rates beneath it.
  const alliance = document.createElement('div');
  alliance.className = 'panel__alliance';
  const trade = document.createElement('div');
  trade.className = 'panel__trade';
  const nobody = document.createElement('div');
  nobody.className = 'panel__detail';
  nobody.textContent = t('panel.neighbours.none');
  tabBodies[TAB_NEIGHBOURS]!.append(alliance, trade, nobody);

  // What a click on the ground will do, when it will do something other than select.
  const tool = document.createElement('div');
  tool.className = 'bar__tool';
  tool.hidden = true;

  element.append(people, selection, tabs, tool);
  parent.appendChild(element);
  showTab(TAB_BUILD);

  /*
   * Say when a section has more than it shows. Watched rather than checked per frame:
   * reading scroll sizes after a write forces a layout, and the bar writes text every
   * frame. A section changes what it holds by changing size — a tab shown, a row of
   * buttons rebuilt — so watching the section and its children is enough.
   */
  const more = new ResizeObserver((entries) => {
    const sections = new Set<HTMLElement>();
    for (const entry of entries) {
      const section = (entry.target as HTMLElement).closest<HTMLElement>('.bar__section');
      if (section !== null) sections.add(section);
    }
    for (const section of sections) markMore(section);
  });
  function markMore(section: HTMLElement): void {
    section.classList.toggle(
      'is-more',
      section.scrollTop + section.clientHeight < section.scrollHeight - 2,
    );
  }
  for (const part of [people, selection, tabs]) {
    part.addEventListener('scroll', () => markMore(part), { passive: true });
    more.observe(part);
    for (const child of part.children) more.observe(child);
  }
  for (const body of tabBodies) for (const child of body.children) more.observe(child);

  /**
   * Rebuilt only when the selection's shape changes.
   *
   * Buttons are DOM nodes with listeners; replacing them every frame would discard the
   * one the player is mid-click on, which reads as the game ignoring input.
   */
  let signature = '';
  let peopleSignature = '';
  // The same, for each row that is rebuilt from what the host sends.
  let offerSignature = '';
  let relationSignature = '';
  let herdSignature = '';
  let rationSignature = '';
  let purseSignature = '';
  let siteHands = 0;
  let villageNames: readonly string[] = [];

  /**
   * What the village holds, and what it knows.
   *
   * Starts empty rather than optimistic: before the first message has arrived the panel
   * knows nothing, and drawing every action as affordable would be a guess that is
   * wrong for exactly as long as it takes to be corrected.
   */
  let purse: Purse = { grain: 0, wood: 0, cattle: 0 };
  let techStatus: readonly number[] = [];
  let trainCosts: TrainCosts = [];
  /** The selected homestead's "raise a household", while one is selected. */
  let trainAction: { action: Action; finished: boolean } | null = null;
  let plantButton: HTMLButtonElement | null = null;
  let patrolButton: HTMLButtonElement | null = null;
  let holding: { armed: BuildingType | null; planting: boolean; patrolling: boolean } = {
    armed: null,
    planting: false,
    patrolling: false,
  };

  /** The sentence for a refusal, with the numbers filled in where it has any. */
  function reasonFor(refusal: Refusal, grain: number, cattle: number, wood: number): string {
    const key = REFUSAL_KEYS[refusal];
    if (key === null) return '';
    if (refusal === Refusal.Grain) return t(key, { need: grain, has: Math.floor(purse.grain) });
    if (refusal === Refusal.Wood) return t(key, { need: wood, has: Math.floor(purse.wood) });
    if (refusal === Refusal.Cattle) return t(key, { need: cattle, has: Math.floor(purse.cattle) });
    return t(key);
  }

  /** Repaint every refusal against the purse as it stands. */
  function paintRefusals(): void {
    for (const spec of Object.values(BUILDINGS)) {
      const refusal = buildAvailability(spec, purse);
      buildActions.get(spec.type)!.refuse(
        refusal,
        reasonFor(refusal, spec.grainCost, spec.cattleCost, spec.woodCost),
        purse,
      );
    }
    for (let i = 0; i < TECH_IDS.length; i++) {
      const spec = TECHS[TECH_IDS[i] as TechId];
      const status = techStatus[i] ?? 0;
      const refusal = researchAvailability(spec, purse, status === 2, status === 1);
      researchActions[i]!.refuse(
        refusal,
        reasonFor(refusal, spec.grainCost, spec.cattleCost, 0),
        purse,
      );
    }
    if (trainAction !== null) {
      const cost = trainCosts[MOVEMENT_INFANTRY] ?? { grain: 0, cattle: 0 };
      // The queue is not in the snapshot, so the panel cannot see its depth and
      // passes zero. QueueFull is therefore a refusal this surface never reports,
      // and the simulation still enforces it — which is the right way round, but it
      // means a full queue is the one silent refusal left. Carrying the depth across
      // would be a world array and a snapshot field for one line of text.
      const refusal = trainAvailability(purse, trainAction.finished, 0, Infinity, cost);
      trainAction.action.refuse(refusal, reasonFor(refusal, cost.grain, cost.cattle, 0), purse);
    }
  }

  /** Light the button whose tool is in hand, and say how to put it down. */
  function paintTool(): void {
    for (const [type, built] of buildActions) {
      built.element.classList.toggle('is-armed', type === holding.armed);
    }
    plantButton?.classList.toggle('is-armed', holding.planting);
    patrolButton?.classList.toggle('is-armed', holding.patrolling);
    if (holding.armed !== null) {
      tool.textContent = t('panel.tool.placing', {
        name: t(buildingSpec(holding.armed).nameKey as MessageKey),
      });
    } else if (holding.planting) {
      tool.textContent = t('panel.tool.planting');
    } else if (holding.patrolling) {
      tool.textContent = t('panel.tool.patrolling');
    }
    tool.hidden = holding.armed === null && !holding.planting && !holding.patrolling;
  }

  function showBuilding(subtype: number, handle: number, finished: boolean): void {
    const spec = buildingSpec(subtype);
    actions.replaceChildren();
    how.textContent = '';
    plantButton = null;
    patrolButton = null;
    trainAction = null;
    // Two clicks, because nothing comes back: the first arms it and says so.
    const demolish = button(t('panel.demolish'), t('panel.demolishHint'), () => {
      if (demolish.dataset.armed === '1') {
        handlers.onDemolish(handle);
        return;
      }
      demolish.dataset.armed = '1';
      demolish.textContent = t('panel.demolishConfirm');
    });
    demolish.classList.add('panel__button--danger');
    if (spec.trains) {
      // One button: a homestead raises a household. It offered a spearman and a
      // horseman, which is the war this game stopped being (ADR-0019, ADR-0020); the
      // simulation keeps its mounted class, but nothing a village does now calls for it.
      const cost = trainCosts[MOVEMENT_INFANTRY] ?? { grain: 0, cattle: 0 };
      const raise = action(
        t('panel.trainHousehold'),
        t('panel.trainHouseholdHint'),
        { grain: cost.grain, wood: 0, cattle: cost.cattle },
        'T',
        () => handlers.onTrain(handle, MOVEMENT_INFANTRY),
      );
      trainAction = { action: raise, finished };
      actions.append(raise.element);
    }
    actions.append(demolish);
    paintRefusals();
  }

  function showPeople(): void {
    actions.replaceChildren();
    trainAction = null;
    plantButton = button(t('panel.orders.plant'), t('panel.orders.plantHint'), handlers.onPlant);
    plantButton.append(keyBadge('F'));
    patrolButton = button(t('panel.orders.patrol'), t('panel.orders.patrolHint'), handlers.onPatrol);
    patrolButton.append(keyBadge('P'));
    actions.append(plantButton, patrolButton);
    how.textContent = t('panel.orders.hint');
    paintTool();
  }

  function clearActions(): void {
    actions.replaceChildren();
    how.textContent = '';
    trainAction = null;
    plantButton = null;
    patrolButton = null;
  }

  /** Reused every update, so counting the village allocates nothing per frame. */
  const roleCounts = new Array<number>(16).fill(0);
  /** Reused every update, so summarising a selection allocates nothing per frame. */
  const selectedRoles: number[] = [];

  /** Count the village's people by what they are doing, and repaint the rows if it moved. */
  function countPeople(view: InterpolatedView): void {
    roleCounts.fill(0);
    let total = 0;
    for (let i = 0; i < view.count; i++) {
      if (view.faction[i] !== options.player || view.kind[i] !== KIND_UNIT) continue;
      // The high nibble of the flags byte, which src/sim/roles.ts writes.
      roleCounts[view.flags[i]! >> 4]!++;
      total++;
    }
    const next = `${total}:${roleCounts.join(',')}`;
    if (next === peopleSignature) return;
    peopleSignature = next;
    peopleHeading.textContent = t('panel.people.heading', { count: total });
    for (const [role, row] of roleButtons) {
      const count = roleCounts[role]!;
      row.textContent = t(ROLE_KEYS[role], { count });
      // Hidden at zero, because eight rows do not fit the bar's height and "0 laid up"
      // says nothing. Except the idle: "0 idle" is news — everyone has work — and it
      // keeps the row a player reaches for most in the same place.
      row.hidden = count === 0 && role !== SummaryRole.None;
      row.disabled = count === 0;
    }
  }

  return {
    element,

    setPurse(next, status, costs): void {
      // A signature over what any refusal could turn on, rounded to whole units: the
      // balance moves continuously and the reasons quote it in whole units.
      const key = `${Math.floor(next.grain)}/${Math.floor(next.wood)}/${Math.floor(next.cattle)}/${status.join('')}/${costs.map((c) => `${c.grain}:${c.cattle}`).join(',')}`;
      purse = next;
      techStatus = status;
      trainCosts = costs;
      if (key === purseSignature) return;
      purseSignature = key;
      paintRefusals();
    },

    setOffers(offers): void {
      const next = offers
        .map((o) => `${o.partner}:${o.offered}>${o.wanted}:${Math.round(o.get)}`)
        .join('|');
      if (next === offerSignature) return;
      offerSignature = next;

      trade.replaceChildren();
      for (const offer of offers) {
        const give = `${Math.round(offer.give)} ${t(RESOURCE_KEYS[offer.offered])}`;
        const get = `${Math.round(offer.get)} ${t(RESOURCE_KEYS[offer.wanted])}`;
        trade.append(
          button(t('panel.trade', { give, get }), t('panel.tradeHint'), () =>
            handlers.onTrade(offer.partner, offer.offered, offer.wanted, offer.give),
          ),
        );
      }
      nobody.hidden = offers.length > 0 || alliance.childElementCount > 0;
    },

    setHerd(head): void {
      const next = String(head);
      if (next === herdSignature) return;
      herdSignature = next;

      herd.replaceChildren();
      if (head <= 0) return;
      const cull = button(t('panel.cull', { head }), t('panel.cullHint'), handlers.onCull);
      cull.classList.add('panel__button--danger');
      herd.append(cull);
    },

    setRation(short, hungry): void {
      const next = `${short}/${hungry}`;
      if (next === rationSignature) return;
      rationSignature = next;

      ration.replaceChildren();
      const control = button(
        short ? t('panel.rationFull') : t('panel.rationShort'),
        short ? t('panel.rationFullHint') : t('panel.rationShortHint'),
        () => handlers.onRation(!short),
      );
      // Amber while the village is actually going short, which is when the button is
      // worth looking at. Not an alert: cutting the ration is a decision, and a village
      // that is merely thin may well want to keep working at full speed.
      const urgent = hungry && !short;
      control.classList.toggle('is-urgent', urgent);
      control.classList.toggle('is-active', short);
      ration.append(control);
      // The tab says so too, since the button is behind it most of the time.
      tabButtons[TAB_VILLAGE]!.classList.toggle('has-news', urgent);
    },

    setRelations(relations): void {
      // Standing is rounded to whole percent in the signature as well as on screen, so a
      // row that recovers 0.4% a season rebuilds when the number the player reads moves
      // and not on every upkeep.
      const next = relations
        .map(
          (r) =>
            `${r.partner}:${r.allied ? 1 : 0}${r.wouldAlly ? 1 : 0}${r.asking ? 1 : 0}` +
            `${r.asked ? 1 : 0}:${Math.round(r.standing * 100)}`,
        )
        .join('|');
      if (next === relationSignature) return;
      relationSignature = next;

      alliance.replaceChildren();
      let asking = false;
      for (const relation of relations) {
        const village = villageNames[relation.partner] ?? t('panel.village', { index: relation.partner + 1 });
        const standing = Math.round(relation.standing * 100);

        if (relation.allied) {
          const label = document.createElement('div');
          label.className = 'panel__standing';
          label.textContent = t('panel.allied', { village, standing });
          alliance.append(
            label,
            button(t('panel.breakBond', { village }), t('panel.breakHint'), () =>
              handlers.onBreak(relation.partner),
            ),
          );
          continue;
        }

        // Somebody is waiting on an answer. Shown first and as its own line, because a
        // tie costs cattle every season and used to be entered on this player's behalf
        // without anyone asking them.
        if (relation.asking) {
          asking = true;
          const label = document.createElement('div');
          label.className = 'panel__standing';
          label.textContent = t('panel.allyAsking', { village });
          alliance.append(label);
          if (relation.wouldAlly) {
            alliance.append(
              button(t('panel.allyAccept', { village }), t('panel.allyHint'), () =>
                handlers.onAlly(relation.partner),
              ),
            );
          }
          alliance.append(
            button(t('panel.allyWithdraw'), t('panel.allyWithdraw'), () =>
              handlers.onBreak(relation.partner),
            ),
          );
          continue;
        }

        if (relation.asked) {
          const label = document.createElement('div');
          label.className = 'panel__standing';
          label.textContent = t('panel.allyWaiting', { village });
          alliance.append(
            label,
            button(t('panel.allyWithdraw'), t('panel.allyWithdraw'), () =>
              handlers.onBreak(relation.partner),
            ),
          );
          continue;
        }

        if (relation.wouldAlly) {
          alliance.append(
            button(t('panel.ally', { village }), t('panel.allyHint'), () =>
              handlers.onAlly(relation.partner),
            ),
          );
          continue;
        }

        // Shown rather than hidden: a neighbour who will not have you is the whole cost
        // of having broken faith, and a row that vanished would read as a bug.
        const refused = document.createElement('div');
        refused.className = 'panel__standing';
        refused.textContent = t('panel.allyRefused', { village, standing });
        alliance.append(refused);
      }
      // A neighbour waiting on an answer is the one thing on this tab that will not wait.
      tabButtons[TAB_NEIGHBOURS]!.classList.toggle('has-news', asking);
      nobody.hidden = trade.childElementCount > 0 || alliance.childElementCount > 0;
    },

    setSiteHands(hands): void {
      siteHands = hands;
    },

    setVillageNames(names): void {
      villageNames = names;
      relationSignature = '';
    },

    setTool(armed, planting, patrolling): void {
      if (
        armed === holding.armed &&
        planting === holding.planting &&
        patrolling === holding.patrolling
      ) {
        return;
      }
      // A building picked up from its key brings its tab forward, so the lit button
      // is on screen and the player can see what they are holding.
      if (armed !== null && armed !== holding.armed) showTab(TAB_BUILD);
      holding = { armed, planting, patrolling };
      paintTool();
    },

    update(view, selected, field): void {
      if (view !== null) countPeople(view);

      if (view === null || selected.size === 0) {
        if (field !== undefined && field !== null) {
          if (signature !== 'field') {
            selectionHeading.textContent = t('panel.field.heading');
            clearActions();
            signature = 'field';
          }
          const condition = Math.round(field.condition * 100);
          const { hands, wanted } = field;
          detail.textContent = field.resting
            ? t('panel.field.resting', { condition, hands })
            : wanted === 0
              ? t('panel.field.far', { condition, hands })
              : !field.established
                ? t('panel.field.breaking', { hands, wanted })
                : t('panel.field.worked', { condition, hands, wanted });
          detail.classList.toggle('panel__detail--idle', !field.resting && hands === 0);
          return;
        }
        if (signature !== 'empty') {
          selectionHeading.textContent = t('panel.nothing');
          detail.textContent = t('panel.nothingHint');
          detail.classList.remove('panel__detail--idle');
          clearActions();
          signature = 'empty';
        }
        return;
      }

      // A single building is the interesting case; anything else is some people.
      let buildingSlot = -1;
      let units = 0;
      selectedRoles.length = 0;
      for (let i = 0; i < view.count; i++) {
        if (!selected.has(view.handle[i]!)) continue;
        if (view.kind[i] === KIND_BUILDING) buildingSlot = i;
        else if (view.kind[i] === KIND_UNIT) {
          units++;
          selectedRoles.push(view.flags[i]! >> 4);
        }
      }

      if (buildingSlot !== -1 && units === 0) {
        const subtype = view.subtype[buildingSlot]!;
        const handle = view.handle[buildingSlot]!;
        const progress = view.progressPct[buildingSlot]!;
        const builders = view.builders[buildingSlot]!;
        const spec = buildingSpec(subtype);
        // Whether it is finished is part of the signature, not only of the state: a
        // site that completes while selected has to redraw its Train button from
        // "Not built yet" to live, and nothing else about the selection changed.
        const finished = progress >= 255;
        const next = `b:${subtype}:${handle}:${finished}`;

        if (signature !== next) {
          selectionHeading.textContent = t(spec.nameKey as MessageKey);
          showBuilding(subtype, handle, finished);
          signature = next;
        }
        // Progress changes constantly, so it lives outside the rebuild check. So does
        // the builder count, and it is the half that tells the player what to DO: a site
        // at 12% with nobody on it and a site at 12% with six people on it want opposite
        // things from them, and until this they looked identical.
        //
        // A finished building that needs staff says the same kind of thing: it pays in
        // proportion to the hands at it (Phase B2), and one standing empty looks exactly
        // like one that is working.
        const name = t(spec.nameKey as MessageKey);
        detail.textContent =
          progress >= 255
            ? spec.hands === 0
              ? t(BUILDING_INFO[spec.type])
              : builders === 0
                ? t('panel.unstaffed', { name })
                : t('panel.staffed', { name, hands: Math.min(builders, spec.hands), wanted: spec.hands })
            : builders === 0
              ? t('panel.siteIdle', { name, pct: Math.round((progress / 255) * 100) })
              : t('panel.siteBuilding', {
                  name,
                  pct: Math.round((progress / 255) * 100),
                  builders,
                  wanted: siteHands,
                });
        detail.classList.toggle('panel__detail--idle', (progress < 255 || spec.hands > 0) && builders === 0);
        return;
      }

      const summary = summariseSelection(selectedRoles);
      // The tallies are in the signature, not only the count: a selection whose people
      // walk into a field is the same selection doing something different, and that is
      // exactly the change worth redrawing for.
      const shape = summary.tallies.map((tally) => `${tally.role}x${tally.count}`).join(',');
      const next = `u:${units}:${shape}`;
      if (signature !== next) {
        selectionHeading.textContent = t('panel.units', { count: units });
        detail.replaceChildren();
        const line = document.createElement('div');
        line.className = 'panel__role';
        // One line, commonest first — the summary's ordering is the design.
        line.textContent = summary.tallies
          .map((tally) => t(ROLE_KEYS[tally.role], { count: tally.count }))
          .join(' · ');
        detail.append(line);
        detail.classList.remove('panel__detail--idle');
        if (!signature.startsWith('u:')) showPeople();
        signature = next;
      }
    },
  };
}
