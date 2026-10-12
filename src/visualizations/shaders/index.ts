/**
 * GLSL shader modes — draw/reset/dispose/interact entry points for the registry.
 */
import { drawShader, resetShader, disposeShaderRunner, interactShader } from './runner';
import { SHADER_DEFS } from './library';
import { store } from '../../state/store';

export const SHADER_MODES = Object.keys(SHADER_DEFS) as (keyof typeof SHADER_DEFS)[];

export const drawSdfTunnel = (p: P5Instance, dt: number) => drawShader(p, dt, SHADER_DEFS.sdftunnel);
export const drawNebula = (p: P5Instance, dt: number) => drawShader(p, dt, SHADER_DEFS.nebula);
export const drawTuring = (p: P5Instance, dt: number) => drawShader(p, dt, SHADER_DEFS.turing);
export const drawKifs = (p: P5Instance, dt: number) => drawShader(p, dt, SHADER_DEFS.kifs);

export { resetShader, interactShader };

/** Dispose only when leaving shader modes altogether (dispose runs after the mode switch). */
export function disposeShader(): void {
  if (!(SHADER_MODES as string[]).includes(store.state.vizMode)) disposeShaderRunner();
}
