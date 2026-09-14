import { t, type MessageKey } from '../core/i18n/index.js';
import { FactionId } from '../shared/factions/index.js';
import { MAP_SCRIPTS, type MapScript } from '../shared/maps.js';

/**
 * Choose a match before playing it.
 *
 * The alternative was editing the query string, which is not a menu — and which meant
 * the four map scripts, all tested and all with distinct tactical character, were
 * effectively unreachable for anyone who had not read main.ts.
 *
 * This does not replace the query parameters. They predate it, they are how the perf
 * harness and the screenshot tooling ask for a specific match, and they still win.
 */

export interface SetupChoice {
  readonly mapScript: MapScript | null;
  readonly mapSeed: number;
  readonly playerFaction: FactionId;
  readonly enemyFaction: FactionId;
}

/** Map keys, in the order they are offered. Null is the generated heightmap. */
const MAPS: readonly (MapScript | null)[] = [null, ...MAP_SCRIPTS];

const MAP_LABELS: Readonly<Record<string, MessageKey>> = {
  null: 'setup.mapOpen',
  'thaba-bosiu': 'setup.mapThabaBosiu',
  umfolozi: 'setup.mapUmfolozi',
  karoo: 'setup.mapKaroo',
  magaliesberg: 'setup.mapMagaliesberg',
};

const FACTION_LABELS: Readonly<Record<FactionId, MessageKey>> = {
  [FactionId.Zulu]: 'faction.zulu',
  [FactionId.Sotho]: 'faction.sotho',
  [FactionId.Ndebele]: 'faction.ndebele',
  [FactionId.Griqua]: 'faction.griqua',
};

const FACTIONS = Object.values(FactionId);

function field(parent: HTMLElement, labelKey: MessageKey): HTMLElement {
  const row = document.createElement('label');
  row.className = 'setup-field';
  const caption = document.createElement('span');
  caption.textContent = t(labelKey);
  row.appendChild(caption);
  parent.appendChild(row);
  return row;
}

export function showSetup(parent: HTMLElement, initial: SetupChoice): Promise<SetupChoice> {
  return new Promise((resolve) => {
    const screen = document.createElement('div');
    screen.className = 'setup';

    const panel = document.createElement('div');
    panel.className = 'setup-panel';
    screen.appendChild(panel);

    const heading = document.createElement('h1');
    heading.textContent = t('app.title');
    panel.appendChild(heading);

    const mapSelect = document.createElement('select');
    for (const script of MAPS) {
      const option = document.createElement('option');
      option.value = script ?? '';
      option.textContent = t(MAP_LABELS[String(script)]!);
      if (script === initial.mapScript) option.selected = true;
      mapSelect.appendChild(option);
    }
    field(panel, 'setup.map').appendChild(mapSelect);

    const factionSelect = document.createElement('select');
    for (const faction of FACTIONS) {
      const option = document.createElement('option');
      option.value = faction;
      // Faction names are proper nouns and are never translated, only glossed.
      // See docs/CONTENT.md section 2.
      option.textContent = t(FACTION_LABELS[faction]);
      if (faction === initial.playerFaction) option.selected = true;
      factionSelect.appendChild(option);
    }
    field(panel, 'setup.faction').appendChild(factionSelect);

    const seedInput = document.createElement('input');
    seedInput.type = 'number';
    seedInput.value = String(initial.mapSeed);
    field(panel, 'setup.seed').appendChild(seedInput);

    const start = document.createElement('button');
    start.className = 'setup-start';
    start.textContent = t('setup.start');
    panel.appendChild(start);

    function begin(): void {
      const chosen = mapSelect.value === '' ? null : (mapSelect.value as MapScript);
      const player = factionSelect.value as FactionId;
      const seed = Number(seedInput.value);
      screen.remove();
      resolve({
        mapScript: chosen,
        // A seed of zero or a blank box falls back rather than generating the same flat
        // nothing every time, which is what Number('') gives.
        mapSeed: Number.isFinite(seed) && seed !== 0 ? seed : initial.mapSeed,
        playerFaction: player,
        // The opponent is whoever the player is not, so the two are never the same
        // people fighting themselves.
        enemyFaction: FACTIONS.find((faction) => faction !== player) ?? FactionId.Sotho,
      });
    }

    start.addEventListener('click', begin);
    screen.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') begin();
    });

    parent.appendChild(screen);
    start.focus();
  });
}
