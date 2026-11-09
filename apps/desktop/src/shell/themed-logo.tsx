import React from 'react';
import logo from '../assets/logo.png';
import logoDark from '../assets/logo-dark.png';

/**
 * The brand logo for the resolved theme (ET-082): the white line art on dark surfaces, the dark variant without a plate on
 * light ones. `<picture>` reads the colour scheme itself, so `system` mode switches with Windows without any renderer state.
 */
export function ThemedLogo({width, height}: {width?: number; height?: number}) {
  return <picture><source media="(prefers-color-scheme: light)" srcSet={logoDark} /><img src={logo} alt="" width={width} height={height} /></picture>;
}
