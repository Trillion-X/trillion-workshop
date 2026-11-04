// packages/group/show/BoardChromeMenu.tsx
//
// One compact board-chrome trigger that progressively discloses caller-owned
// controls in named sections. The menu owns only transient open/collapse state;
// every capability and handler remains owned by GroupBoardPanel.

import React, { useEffect, useRef, useState } from 'react';
import { AnchoredOverlay, Button, Card, Container, Icon, Text } from '../../ui';
import { ChevronDown, LayoutPanelTop, Plus } from 'lucide-react';

export interface BoardChromeMenuGroup {
  readonly label: string;
  readonly children: React.ReactNode;
  readonly defaultOpen?: boolean;
}

export interface BoardChromeMenuProps {
  readonly label: 'Add' | 'Board';
  readonly groups: readonly BoardChromeMenuGroup[];
  readonly dismissWhen?: boolean;
}

export function BoardChromeMenu({ label, groups, dismissWhen = false }: BoardChromeMenuProps) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (dismissWhen) setOpen(false); }, [dismissWhen]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(groups.filter((group) => group.defaultOpen).map((group) => group.label)),
  );

  const toggleGroup = (groupLabel: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(groupLabel)) next.delete(groupLabel);
      else next.add(groupLabel);
      return next;
    });
  };

  return (
    <>
      <Button
        ref={anchorRef}
        variant={label === 'Add' ? 'secondary' : 'ghost'}
        size="sm"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Open ${label.toLowerCase()} menu`}
        data-reach-action={label === 'Add' ? 'board-add' : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon icon={label === 'Add' ? Plus : LayoutPanelTop} size="sm" />
        {label}
        <Icon icon={ChevronDown} size="xs" />
      </Button>
      <AnchoredOverlay anchorRef={anchorRef} open={open && !dismissWhen} onDismiss={() => setOpen(false)}>
        <Card variant="popover" padding="sm">
          <Container
            layout="vertical"
            gap="xs"
            style={{ width: 300, maxHeight: 'min(68vh, 620px)', overflowY: 'auto' }}
            aria-label={`${label} menu`}
          >
            {groups.map((group) => {
              const groupOpen = expanded.has(group.label);
              return (
                <Container key={group.label} layout="vertical" gap="xs">
                  <Button
                    variant="ghost"
                    size="sm"
                    fullWidth
                    aria-expanded={groupOpen}
                    aria-label={`${groupOpen ? 'Collapse' : 'Expand'} ${group.label}`}
                    onClick={() => toggleGroup(group.label)}
                  >
                    <Container layout="horizontal" justifyContent="between" alignItems="center" width="full">
                      <Text variant="body-sm" weight="medium">{group.label}</Text>
                      <Container style={{ transform: groupOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 140ms ease' }}>
                        <Icon icon={ChevronDown} size="xs" />
                      </Container>
                    </Container>
                  </Button>
                  {groupOpen ? (
                    <Container
                      layout="horizontal"
                      gap="xs"
                      wrap
                      padding="xs"
                      style={{ paddingTop: 0 }}
                    >
                      {group.children}
                    </Container>
                  ) : null}
                </Container>
              );
            })}
          </Container>
        </Card>
      </AnchoredOverlay>
    </>
  );
}
