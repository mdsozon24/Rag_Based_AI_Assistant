'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Check, ChevronsUpDown, LogOut, Menu as MenuIcon, Monitor, Moon, Plus, Sun, X } from 'lucide-react';
import { Dialog as RadixDialog } from 'radix-ui';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { FormError } from '@/components/ui/form-error';
import { Input } from '@/components/ui/input';
import { Menu, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator } from '@/components/ui/menu';
import { useToast } from '@/components/ui/toast';
import { post } from '@/lib/api/client';
import { apiErrorsFor, focusFirstError, validate, type FieldErrors } from '@/lib/forms';
import { createOrgSchema } from '@/lib/schemas/auth';
import { useOrgSwitch, useSession } from '@/lib/session';
import { applyTheme, readThemeChoice, type ThemeChoice } from '@/lib/theme';
import { Logo } from './logo';
import { SidebarNav } from './sidebar';

export function OrgSwitcher() {
  const { me, org } = useSession();
  const { switchTo } = useOrgSwitch();
  const router = useRouter();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  return (
    <>
      <Menu
        align="start"
        label="Organizations"
        trigger={
          <Button variant="ghost" className="max-w-56 justify-between gap-2 px-2.5" aria-label={`Organization: ${org.name}. Switch organization`}>
            <span className="truncate font-semibold">{org.name}</span>
            <ChevronsUpDown aria-hidden="true" className="text-muted" />
          </Button>
        }
      >
        <MenuLabel>Your organizations</MenuLabel>
        {me.orgs.map((o) => (
          <MenuItem
            key={o.id}
            onSelect={async () => {
              if (o.id === org.id) return;
              try {
                await switchTo(o.id);
                router.push('/assistants');
              } catch (error) {
                toast.error('Could not switch organization', error);
              }
            }}
          >
            <Check aria-hidden="true" className={o.id === org.id ? 'opacity-100' : 'opacity-0'} />
            <span className="flex-1 truncate">{o.name}</span>
            <span className="text-xs text-muted capitalize">{o.role}</span>
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem onSelect={() => setCreating(true)}>
          <Plus aria-hidden="true" />
          Create organization
        </MenuItem>
      </Menu>
      <CreateOrgDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}

export function CreateOrgDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { create } = useOrgSwitch();
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [name, setName] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const checked = validate(createOrgSchema, { name });
    if (!checked.ok) {
      setErrors(checked.errors);
      focusFirstError(formRef.current);
      return;
    }
    setBusy(true);
    try {
      await create(checked.value.name);
      onOpenChange(false);
      setName('');
      router.push('/assistants');
    } catch (error) {
      setErrors(apiErrorsFor(error));
      focusFirstError(formRef.current);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create organization"
      description="You will be its owner. Assistants, numbers and calls are kept separate per organization."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="create-org" loading={busy}>
            Create
          </Button>
        </>
      }
    >
      <form id="create-org" ref={formRef} onSubmit={submit} noValidate className="flex flex-col gap-3">
        <FormError errors={errors} shown={['name']} />
        <Field label="Name" error={errors.name} required>
          {(props) => <Input {...props} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
      </form>
    </Dialog>
  );
}

export function ThemeMenu() {
  // Rendered only in the browser (after the session loads), so storage can be read at once
  const [choice, setChoice] = useState<ThemeChoice>(readThemeChoice);
  // Follow the system while the choice is "system"
  useEffect(() => {
    if (choice !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = () => applyTheme('system');
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, [choice]);
  const Icon = choice === 'dark' ? Moon : choice === 'light' ? Sun : Monitor;
  return (
    <Menu
      label="Theme"
      trigger={
        <Button variant="ghost" size="sm" className="w-9 px-0" aria-label={`Theme: ${choice}`}>
          <Icon aria-hidden="true" />
        </Button>
      }
    >
      <MenuLabel>Theme</MenuLabel>
      <MenuRadioGroup
        value={choice}
        onValueChange={(value) => {
          const next = value as ThemeChoice;
          setChoice(next);
          applyTheme(next);
        }}
      >
        <MenuRadioItem value="light">Light</MenuRadioItem>
        <MenuRadioItem value="dark">Dark</MenuRadioItem>
        <MenuRadioItem value="system">System</MenuRadioItem>
      </MenuRadioGroup>
    </Menu>
  );
}

export function UserMenu() {
  const { me, role } = useSession();
  const client = useQueryClient();
  const router = useRouter();
  const toast = useToast();
  const initials = (me.user.name || me.user.email).split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  return (
    <Menu
      label="Account"
      trigger={
        <Button variant="ghost" size="sm" className="w-9 rounded-full px-0" aria-label={`Account: ${me.user.name || me.user.email}`}>
          <span aria-hidden="true" className="flex size-8 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent-text">
            {initials}
          </span>
        </Button>
      }
    >
      <div className="px-2.5 py-2">
        <p className="truncate text-sm font-semibold text-text">{me.user.name}</p>
        <p className="truncate text-xs text-muted">{me.user.email}</p>
        <p className="mt-1 text-xs text-muted capitalize">Role: {role}</p>
      </div>
      <MenuSeparator />
      <MenuItem
        onSelect={async () => {
          try {
            await post('/v1/auth/logout');
          } catch (error) {
            toast.error('Could not sign out', error);
            return;
          }
          // Nothing of the org stays in memory after signing out
          client.clear();
          router.replace('/login');
        }}
      >
        <LogOut aria-hidden="true" />
        Sign out
      </MenuItem>
    </Menu>
  );
}

/** Phones and small tablets: the navigation in a drawer. */
export function MobileNav() {
  const [open, setOpen] = useState(false);
  return (
    <RadixDialog.Root open={open} onOpenChange={setOpen}>
      <RadixDialog.Trigger asChild>
        <Button variant="ghost" size="sm" className="w-9 px-0 lg:hidden" aria-label="Open navigation">
          <MenuIcon aria-hidden="true" />
        </Button>
      </RadixDialog.Trigger>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-overlay lg:hidden" />
        <RadixDialog.Content className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col overflow-y-auto border-r border-border bg-surface lg:hidden" aria-describedby={undefined}>
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <RadixDialog.Title asChild>
              <span>
                <Logo />
              </span>
            </RadixDialog.Title>
            <RadixDialog.Close asChild>
              <Button variant="ghost" size="sm" className="w-9 px-0" aria-label="Close navigation">
                <X aria-hidden="true" />
              </Button>
            </RadixDialog.Close>
          </div>
          <SidebarNav onNavigate={() => setOpen(false)} />
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
