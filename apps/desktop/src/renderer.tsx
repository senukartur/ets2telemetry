import React from 'react';
import {createRoot} from 'react-dom/client';
import type {DesktopBridge, OverlayBridge} from '../../../packages/contracts/src';

declare global {interface Window {desktop: DesktopBridge; overlay: OverlayBridge}}

// Load each view's stylesheet only after selection so the overlay never loads the opaque dashboard base layer.
const overlayView = new URLSearchParams(window.location.search).get('view') === 'overlay';
if (overlayView) document.body.classList.add('overlay-body');
const {default: View} = overlayView ? await import('./overlay-renderer') : await import('./dashboard-renderer');
createRoot(document.getElementById('root')!).render(<View/>);
