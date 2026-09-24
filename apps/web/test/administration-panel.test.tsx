import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AdministrationPanel } from '../components/administration-panel';
import type { Member } from '../lib/api';

const members: Member[] = [
  {
    id: 'owner',
    userId: 'user-owner',
    organizationId: 'org',
    displayName: 'Ada Owner',
    role: 'OWNER',
    status: 'ACTIVE',
  },
  {
    id: 'responder',
    userId: 'user-responder',
    organizationId: 'org',
    displayName: 'Lee Responder',
    role: 'RESPONDER',
    status: 'ACTIVE',
  },
];

describe('administration panel', () => {
  it('shows team management and only permits an Owner to invite another Owner', () => {
    const render = (role: 'OWNER' | 'ADMIN') =>
      renderToStaticMarkup(
        <AdministrationPanel
          organizationId="org"
          members={members}
          role={role}
          onMembersChanged={() => Promise.resolve()}
        />,
      );
    expect(render('OWNER')).toContain('Ada Owner');
    expect(render('OWNER')).toContain('Invite a teammate');
    expect(render('OWNER')).toContain('<option value="OWNER">Owner</option>');
    expect(render('ADMIN').split('name="role"')[1]?.split('</select>')[0]).not.toContain(
      '<option value="OWNER">Owner</option>',
    );
  });
});
