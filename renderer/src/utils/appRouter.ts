import { createBrowserRouter, createHashRouter, type RouteObject } from 'react-router-dom';
export function createAppRouter(routes: RouteObject[], target: Window = window) {
  return (target.location.protocol === 'file:' ? createHashRouter : createBrowserRouter)(routes, { window: target });
}
