import * as React from 'react';
import {DropdownMenu as Menu} from 'radix-ui';
export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;
export const DropdownMenuRadioGroup = Menu.RadioGroup;
export function DropdownMenuContent(props: React.ComponentProps<typeof Menu.Content>) {
  return <Menu.Portal><Menu.Content sideOffset={6} className="yu-menu" {...props} /></Menu.Portal>;
}
export function DropdownMenuRadioItem(props: React.ComponentProps<typeof Menu.RadioItem>) {
  return <Menu.RadioItem className="yu-menu-item" {...props} />;
}
