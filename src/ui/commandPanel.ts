import { BUILDINGS, BuildingType, buildingSpec } from '../shared/buildings/index.js';
import { TECHS, TECH_IDS, type TechId } from '../shared/tech/index.js';
import { t, type MessageKey } from '../core/i18n/index.js';
import type { InterpolatedView } from '../render/interpolation.js';
import type { TradeOffer } from '../sim/trade.js';

/** Resource index -> its name key. Order matches Resource in the ledger. */
const RESOURCE_KEYS: readonly MessageKey[] = [
  'resource.cattle',
  'resource.grain',
  'resource.ammunition',
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

const KIND_UNIT = 0;
const KIND_BUILDING = 2;
const MOVEMENT_INFANTRY = 0;
const MOVEMENT_MOUNTED = 2;

export interface CommandPanelHandlers {
  onTrain(buildingHandle: number, movementClass: number): void;
  onArmBuild(type: BuildingType): void;
  onResearch(techIndex: number): void;
  onTrade(partner: number, offered: number, wanted: number, amount: number): void;
}

export interface CommandPanel {
  readonly element: HTMLElement;
  update(view: InterpolatedView | null, selected: ReadonlySet<number>): void;
  /**
   * What the neighbours will trade, and at what rate.
   *
   * A row of its own, always shown, because trade belongs to the village rather than to
   * whatever happens to be selected — and because the rate is news: it is the only
   * window a player has onto what a neighbour is short of.
   */
  setOffers(offers: readonly TradeOffer[]): void;
}

function button(label: string, hint: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.className = 'panel__button';
  element.textContent = label;
  element.title = hint;
  element.addEventListener('click', onClick);
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

  element.append(heading, detail, actions, trade);
  parent.appendChild(element);

  /**
   * Rebuilt only when the selection's shape changes.
   *
   * Buttons are DOM nodes with listeners; replacing them every frame would discard the
   * one the player is mid-click on, which reads as the game ignoring input.
   */
  let signature = '';

  function buildActions(kind: number, subtype: number, handle: number): void {
    actions.replaceChildren();

    if (kind === KIND_BUILDING) {
      const spec = buildingSpec(subtype);
      if (!spec.trains) return;
      actions.append(
        button(t('panel.trainInfantry'), t('panel.trainInfantry'), () =>
          handlers.onTrain(handle, MOVEMENT_INFANTRY),
        ),
        button(t('panel.trainMounted'), t('panel.trainMounted'), () =>
          handlers.onTrain(handle, MOVEMENT_MOUNTED),
        ),
      );
      return;
    }

    // Troops selected: what they can put up, and what the nation can learn.
    for (const spec of Object.values(BUILDINGS)) {
      actions.append(
        button(
          t(spec.nameKey as MessageKey),
          t('panel.costs', { grain: spec.grainCost, cattle: spec.cattleCost }),
          () => handlers.onArmBuild(spec.type),
        ),
      );
    }
    for (let i = 0; i < TECH_IDS.length; i++) {
      const spec = TECHS[TECH_IDS[i] as TechId];
      actions.append(
        button(
          t(spec.nameKey as MessageKey),
          t('panel.costs', { grain: spec.grainCost, cattle: spec.cattleCost }),
          () => handlers.onResearch(i),
        ),
      );
    }
  }

  /** Rebuilt only when the offers actually change, for the reason the actions are. */
  let offerSignature = '';

  return {
    element,

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

    update(view, selected): void {
      if (view === null || selected.size === 0) {
        if (signature !== 'empty') {
          heading.textContent = t('panel.nothing');
          detail.replaceChildren();
          actions.replaceChildren();
          signature = 'empty';
        }
        return;
      }

      // A single building is the interesting case; anything else is "some troops".
      let buildingSlot = -1;
      let units = 0;
      for (let i = 0; i < view.count; i++) {
        if (!selected.has(view.handle[i]!)) continue;
        if (view.kind[i] === KIND_BUILDING) buildingSlot = i;
        else if (view.kind[i] === KIND_UNIT) units++;
      }

      if (buildingSlot !== -1 && units === 0) {
        const subtype = view.subtype[buildingSlot]!;
        const handle = view.handle[buildingSlot]!;
        const progress = view.progressPct[buildingSlot]!;
        const spec = buildingSpec(subtype);
        const next = `b:${subtype}:${handle}`;

        if (signature !== next) {
          heading.textContent = t(spec.nameKey as MessageKey);
          buildActions(KIND_BUILDING, subtype, handle);
          signature = next;
        }
        // Progress changes constantly, so it lives outside the rebuild check.
        detail.textContent =
          progress >= 255
            ? ''
            : t('panel.buildingSite', {
                name: t(spec.nameKey as MessageKey),
                pct: Math.round((progress / 255) * 100),
              });
        return;
      }

      const next = `u:${units}`;
      if (signature !== next) {
        heading.textContent = t('panel.units', { count: units });
        detail.replaceChildren();
        buildActions(KIND_UNIT, 0, 0);
        signature = next;
      }
    },
  };
}
