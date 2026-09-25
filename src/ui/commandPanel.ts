import { BUILDINGS, BuildingType, buildingSpec } from '../shared/buildings/index.js';
import { TECHS, TECH_IDS, type TechId } from '../shared/tech/index.js';
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

/** Resource index -> its name key. Order matches Resource in the ledger. */
const RESOURCE_KEYS: readonly MessageKey[] = [
  'resource.cattle',
  'resource.grain',
  'resource.wood',
];

/**
 * What is selected, and what can be done with it.
 *
 * The controls existed before this did, as undiscoverable hotkeys over a debug readout.
 * A game whose actions can only be found by reading the source is not finished, however
 * complete the simulation underneath it — so this is the surface those actions live on.
 *
 * It is DOM, like the rest of the HUD, for the reasons in ARCHITECTURE section 10:
 * free text shaping for diacritic-heavy isiZulu and Sesotho, accessibility, and far less
 * code than drawing buttons in Pixi.
 */

/** What a soldier costs, by movement class, as the host reports it. */
export type TrainCosts = readonly { readonly grain: number; readonly cattle: number }[];

/** Role -> the line that describes it. Keyed by the enum, so a new role is a compile error. */
const ROLE_KEYS: Readonly<Record<SummaryRole, MessageKey>> = {
  [SummaryRole.None]: 'role.none',
  [SummaryRole.Herder]: 'role.herder',
  [SummaryRole.FieldHand]: 'role.fieldHand',
  [SummaryRole.Carrier]: 'role.carrier',
  [SummaryRole.Elder]: 'role.elder',
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
   * A row of its own, always shown, because trade belongs to the village rather than to
   * whatever happens to be selected — and because the rate is news: it is the only
   * window a player has onto what a neighbour is short of.
   */
  setOffers(offers: readonly TradeOffer[]): void;
  /**
   * The neighbours, and where this village stands with each.
   *
   * Beside the trade row rather than inside it, because the two are the same
   * conversation: standing sets the rate on the row above, so a player who wonders why
   * an offer got worse can see the reason without leaving the panel.
   */
  setRelations(relations: readonly Relation[]): void;
  /** How many head a slaughter would take, as the simulation reckons it. Zero hides it. */
  setHerd(head: number): void;
  /**
   * What the village is eating, and the switch for it.
   *
   * Beside the cull rather than under a selection, because neither is a thing a
   * villager does — they are both the village deciding something about itself, and a
   * player looking for either is looking for the same kind of answer to the same
   * question. Always shown, so a bad year does not have to be survived once before the
   * move is discovered.
   */
  setRation(short: boolean, hungry: boolean): void;
  /**
   * What the village holds and knows, so the actions can say why they are unavailable.
   *
   * Set separately from `update` because it changes on its own clock — the balance
   * moves every upkeep and the selection does not — and because the actions are rebuilt
   * only when the selection's SHAPE changes. Affordability has to be able to repaint a
   * button without replacing the one the player is mid-click on.
   */
  setPurse(purse: Purse, techStatus: readonly number[], trainCosts: TrainCosts): void;
}

function button(label: string, hint: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.className = 'panel__button';
  element.textContent = label;
  element.title = hint;
  element.addEventListener('click', onClick);
  return element;
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

/**
 * A button that says why it cannot be pressed, instead of accepting the click and
 * doing nothing.
 *
 * NOT disabled, except where pressing it is genuinely meaningless. A greyed-out control
 * with a reason on it is readable; a dead one teaches nothing, and the player has to
 * discover by hovering that there was ever an explanation. `NeedsWater` in particular
 * stays live: the refusal is about WHERE, and the player finds out by trying to site
 * it, which is the gesture that teaches the rule.
 */
function actionButton(
  label: string,
  cost: string,
  refusal: Refusal,
  reason: string,
  onClick: () => void,
): HTMLButtonElement {
  const element = button(label, refusal === Refusal.None ? cost : `${cost} — ${reason}`, onClick);
  if (refusal !== Refusal.None) {
    element.classList.add('is-refused');
    const why = document.createElement('span');
    why.className = 'panel__why';
    why.textContent = reason;
    element.append(why);
  }
  return element;
}

export function createCommandPanel(
  parent: HTMLElement,
  handlers: CommandPanelHandlers,
): CommandPanel {
  const element = document.createElement('div');
  element.className = 'panel';

  const heading = document.createElement('div');
  heading.className = 'panel__heading';

  const detail = document.createElement('div');
  detail.className = 'panel__detail';

  const actions = document.createElement('div');
  actions.className = 'panel__actions';

  const trade = document.createElement('div');
  trade.className = 'panel__trade';

  const alliance = document.createElement('div');
  alliance.className = 'panel__alliance';

  // The herd row sits with trade rather than with the selection, because slaughtering is
  // the village's decision and not any particular villager's.
  const herd = document.createElement('div');
  herd.className = 'panel__herd';

  // The ration sits with the herd for the same reason the herd sits away from the
  // selection: both are the village deciding something about itself rather than
  // anything a particular villager does.
  const ration = document.createElement('div');
  ration.className = 'panel__ration';

  element.append(heading, detail, actions, ration, herd, trade, alliance);
  parent.appendChild(element);

  /**
   * Rebuilt only when the selection's shape changes.
   *
   * Buttons are DOM nodes with listeners; replacing them every frame would discard the
   * one the player is mid-click on, which reads as the game ignoring input.
   */
  let signature = '';
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
  /**
   * Whether the selected building is finished.
   *
   * Held rather than passed, because `buildActions` is called from the selection path
   * and again when the purse changes, and the second caller has no view to read it
   * from. It is set immediately before every rebuild.
   */
  let shownFinished = false;

  function buildActions(kind: number, subtype: number, handle: number): void {
    lastActions = { kind, subtype, handle };
    actions.replaceChildren();

    if (kind === KIND_BUILDING) {
      const spec = buildingSpec(subtype);
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
      actions.append(demolish);
      if (!spec.trains) return;
      // One button: a homestead raises a household. It offered a spearman and a
      // horseman, which is the war this game stopped being (ADR-0019, ADR-0020); the
      // simulation keeps its mounted class, but nothing a village does now calls for it.
      for (const [movementClass, label] of [[MOVEMENT_INFANTRY, 'panel.trainHousehold']] as const) {
        const cost = trainCosts[movementClass] ?? { grain: 0, cattle: 0 };
        // The queue is not in the snapshot, so the panel cannot see its depth and
        // passes zero. QueueFull is therefore a refusal this surface never reports,
        // and the simulation still enforces it — which is the right way round, but it
        // means a full queue is the one silent refusal left. Carrying the depth across
        // would be a world array and a snapshot field for one line of text.
        const refusal = trainAvailability(purse, shownFinished, 0, Infinity, cost);
        actions.append(
          actionButton(
            t(label),
            t('panel.costs', { grain: cost.grain, cattle: cost.cattle }),
            refusal,
            reasonFor(refusal, cost.grain, cost.cattle, 0),
            () => handlers.onTrain(handle, movementClass),
          ),
        );
      }
      return;
    }

    // People selected: what they can put up, and what the village can learn.
    for (const spec of Object.values(BUILDINGS)) {
      const refusal = buildAvailability(spec, purse);
      actions.append(
        actionButton(
          t(spec.nameKey as MessageKey),
          t('panel.costsFull', {
            grain: spec.grainCost,
            wood: spec.woodCost,
            cattle: spec.cattleCost,
          }),
          refusal,
          reasonFor(refusal, spec.grainCost, spec.cattleCost, spec.woodCost),
          () => handlers.onArmBuild(spec.type),
        ),
      );
    }
    for (let i = 0; i < TECH_IDS.length; i++) {
      const spec = TECHS[TECH_IDS[i] as TechId];
      const status = techStatus[i] ?? 0;
      const refusal = researchAvailability(spec, purse, status === 2, status === 1);
      actions.append(
        actionButton(
          t(spec.nameKey as MessageKey),
          t('panel.costs', { grain: spec.grainCost, cattle: spec.cattleCost }),
          refusal,
          reasonFor(refusal, spec.grainCost, spec.cattleCost, 0),
          () => handlers.onResearch(i),
        ),
      );
    }
  }

  /** The sentence for a refusal, with the numbers filled in where it has any. */
  function reasonFor(refusal: Refusal, grain: number, cattle: number, wood: number): string {
    const key = REFUSAL_KEYS[refusal];
    if (key === null) return '';
    if (refusal === Refusal.Grain) return t(key, { need: grain, has: Math.floor(purse.grain) });
    if (refusal === Refusal.Wood) return t(key, { need: wood, has: Math.floor(purse.wood) });
    if (refusal === Refusal.Cattle) return t(key, { need: cattle, has: Math.floor(purse.cattle) });
    return t(key);
  }

  /** Rebuilt only when the offers actually change, for the reason the actions are. */
  let offerSignature = '';
  let relationSignature = '';
  let herdSignature = '';
  let rationSignature = '';
  let purseSignature = '';
  /** Reused every update, so summarising a selection allocates nothing per frame. */
  const selectedRoles: number[] = [];
  /** What the actions were last built for, so a change of purse can rebuild them. */
  let lastActions: { kind: number; subtype: number; handle: number } | null = null;

  return {
    element,

    setPurse(next, status, costs): void {
      // A signature over what any refusal could turn on, rounded to whole units: the
      // balance moves continuously and rebuilding the actions every frame would discard
      // the button the player is mid-click on, which reads as the game ignoring input.
      const key = `${Math.floor(next.grain)}/${Math.floor(next.wood)}/${Math.floor(next.cattle)}/${status.join('')}`;
      purse = next;
      techStatus = status;
      trainCosts = costs;
      if (key === purseSignature) return;
      purseSignature = key;
      if (lastActions !== null) buildActions(lastActions.kind, lastActions.subtype, lastActions.handle);
    },

    setOffers(offers): void {
      const next = offers
        .map((o) => `${o.partner}:${o.offered}>${o.wanted}:${Math.round(o.get)}`)
        .join('|');
      if (next === offerSignature) return;
      offerSignature = next;

      trade.replaceChildren();
      if (offers.length === 0) return;

      for (const offer of offers) {
        const give = `${Math.round(offer.give)} ${t(RESOURCE_KEYS[offer.offered] ?? 'resource.grain')}`;
        const get = `${Math.round(offer.get)} ${t(RESOURCE_KEYS[offer.wanted] ?? 'resource.grain')}`;
        trade.append(
          button(t('panel.trade', { give, get }), t('panel.tradeHint'), () =>
            handlers.onTrade(offer.partner, offer.offered, offer.wanted, offer.give),
          ),
        );
      }
    },

    setHerd(head): void {
      const next = String(head);
      if (next === herdSignature) return;
      herdSignature = next;

      herd.replaceChildren();
      if (head <= 0) return;
      herd.append(button(t('panel.cull', { head }), t('panel.cullHint'), handlers.onCull));
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
      control.classList.toggle('is-urgent', hungry && !short);
      control.classList.toggle('is-active', short);
      ration.append(control);
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
    },

    setSiteHands(hands): void {
      siteHands = hands;
    },

    setVillageNames(names): void {
      villageNames = names;
      relationSignature = '';
    },

    update(view, selected, field): void {
      if (view === null || selected.size === 0) {
        if (field !== undefined && field !== null) {
          if (signature !== 'field') {
            heading.textContent = t('panel.field.heading');
            actions.replaceChildren();
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
          heading.textContent = t('panel.nothing');
          detail.replaceChildren();
          detail.classList.remove('panel__detail--idle');
          actions.replaceChildren();
          signature = 'empty';
        }
        return;
      }

      // A single building is the interesting case; anything else is "some troops".
      let buildingSlot = -1;
      let units = 0;
      selectedRoles.length = 0;
      for (let i = 0; i < view.count; i++) {
        if (!selected.has(view.handle[i]!)) continue;
        if (view.kind[i] === KIND_BUILDING) buildingSlot = i;
        else if (view.kind[i] === KIND_UNIT) {
          units++;
          // The high nibble of the flags byte. roles.ts writes it; until now the only
          // thing that read it was the sprite chooser, so the picture knew what each
          // villager was doing and the words did not.
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
        // site that completes while selected has to redraw its Train buttons from
        // "Not built yet" to live, and nothing else about the selection changed.
        const finished = progress >= 255;
        const next = `b:${subtype}:${handle}:${finished}`;

        if (signature !== next) {
          shownFinished = finished;
          heading.textContent = t(spec.nameKey as MessageKey);
          buildActions(KIND_BUILDING, subtype, handle);
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
              ? ''
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
        heading.textContent = t('panel.units', { count: units });
        detail.replaceChildren();
        for (const tally of summary.tallies) {
          const line = document.createElement('div');
          line.className = 'panel__role';
          line.textContent = t(ROLE_KEYS[tally.role], { count: tally.count });
          detail.append(line);
        }
        detail.classList.remove('panel__detail--idle');
        buildActions(KIND_UNIT, 0, 0);
        signature = next;
      }
    },
  };
}
