import presentationData from '../../tuning/presentation.json' with { type: 'json' };

/**
 * Presentation constants — camera feel, debug scene, anything the player sees but the
 * simulation never reads.
 *
 * Deliberately a separate file from tuning/tuning.json, which is hashed into every
 * replay. Pan speed has nothing to do with simulation determinism, and folding it into
 * that hash would mean every camera tweak invalidated the golden replay and demanded a
 * re-record. Keeping the two apart keeps the replay gate meaningful: it fires for
 * changes that can actually alter simulation outcomes.
 */
export const presentation = presentationData;
