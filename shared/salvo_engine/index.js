'use strict';

/**
 * salvo_engine
 * ============
 *
 * JavaScript port of the naval_salvo (Python/numpy) heterogeneous
 * multi-domain salvo equation engine, for in-process use by the
 * Node.js game server (turn resolution and bot batch simulations).
 *
 * Ported modules:
 *   domains       - Domain.S/U/A/C/X taxonomy + ordering
 *   admissibility - 5x5 cross-domain admissibility (chi) matrix
 *   state         - UnitType, Force, BattleState
 *   parameters    - PairParameters, DirectionalParameters, EngagementParameters
 *   dynamics      - salvoStep (deterministic pulsed-jump equation)
 *   targeting     - Uniform / StrengthProportional / ThreatWeighted / Manual
 *
 * See /home/user/ref-naval-salvo (naval_salvo Python package) for the
 * reference implementation and its references list.
 */

module.exports = {
  ...require('./domains'),
  ...require('./admissibility'),
  ...require('./state'),
  ...require('./parameters'),
  ...require('./dynamics'),
  ...require('./targeting'),
};
