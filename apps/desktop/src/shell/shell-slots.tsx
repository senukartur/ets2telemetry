import React, {useMemo} from 'react';
import {createPortal} from 'react-dom';

/**
 * ET-076: the places a page can add to the shell without the shell knowing the page: `actions` at the right end of the top
 * bar, `subline` under the page title and `breadcrumb` after the page's crumb (ET-077). The shell keeps the elements in
 * state and hands them down; a page renders its content there with a portal, so it keeps owning that content's state.
 */
export interface ShellSlots {actions: HTMLElement | null; subline: HTMLElement | null; breadcrumb: HTMLElement | null}
const ShellSlotsContext = React.createContext<ShellSlots>({actions: null, subline: null, breadcrumb: null});

export function ShellSlotsProvider({actions, subline, breadcrumb = null, children}: Omit<ShellSlots, 'breadcrumb'> & {breadcrumb?: HTMLElement | null; children: React.ReactNode}) {
  const slots = useMemo(() => ({actions, subline, breadcrumb}), [actions, subline, breadcrumb]);
  return <ShellSlotsContext.Provider value={slots}>{children}</ShellSlotsContext.Provider>;
}

/** Renders `children` into the named slot of the shell, and nothing until the shell has mounted that slot or without a shell. */
export function ShellSlot({name, children}: {name: keyof ShellSlots; children: React.ReactNode}) {
  const element = React.useContext(ShellSlotsContext)[name];
  return element ? createPortal(children, element) : null;
}
