import { Application } from 'pixi.js';

export interface Renderer {
  readonly app: Application;
}

/**
 * Pixi bootstrap. Kept deliberately thin — everything above it is plain data and
 * functions, so the renderer can be swapped or headless-tested without unpicking it.
 */
export async function createRenderer(parent: HTMLElement, background: number): Promise<Renderer> {
  const app = new Application();

  await app.init({
    resizeTo: parent === document.body ? window : parent,
    background,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });

  parent.appendChild(app.canvas);
  return { app };
}
