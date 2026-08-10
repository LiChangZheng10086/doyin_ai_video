import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  LocalUserCreateAction,
  LocalUserPinDialog,
  LocalUserRowActions,
} from './LocalUsersSettings.js';
import type { LocalUser } from '../types/index.js';

const admin: LocalUser = {
  id: 'admin-1',
  displayName: '管理员',
  role: 'admin',
  isActive: true,
  createdAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
};

const publisher: LocalUser = {
  ...admin,
  id: 'publisher-1',
  displayName: '发布者',
  role: 'publisher',
};

const noop = () => undefined;

test('publisher management actions render no buttons while administrators receive CRUD controls', () => {
  const publisherCreate = renderToStaticMarkup(
    <LocalUserCreateAction currentUser={publisher} disabled={false} onCreate={noop} />
  );
  const publisherRows = renderToStaticMarkup(
    <LocalUserRowActions
      currentUser={publisher}
      user={admin}
      disabled={false}
      onRename={noop}
      onRoleChange={noop}
      onResetPin={noop}
      onActiveChange={noop}
    />
  );
  assert.equal(publisherCreate, '');
  assert.equal(publisherRows, '');

  const adminCreate = renderToStaticMarkup(
    <LocalUserCreateAction currentUser={admin} disabled={false} onCreate={noop} />
  );
  const adminRows = renderToStaticMarkup(
    <LocalUserRowActions
      currentUser={admin}
      user={publisher}
      disabled={false}
      onRename={noop}
      onRoleChange={noop}
      onResetPin={noop}
      onActiveChange={noop}
    />
  );
  assert.match(adminCreate, />新建用户<\/button>/);
  assert.match(adminRows, />重命名<\/button>/);
  assert.match(adminRows, />设为管理员<\/button>/);
  assert.match(adminRows, />停用<\/button>/);
});

test('the current administrator disable control is rendered disabled', () => {
  const markup = renderToStaticMarkup(
    <LocalUserRowActions
      currentUser={admin}
      user={admin}
      disabled={false}
      onRename={noop}
      onRoleChange={noop}
      onResetPin={noop}
      onActiveChange={noop}
    />
  );

  assert.match(markup, /<button[^>]*disabled=""[^>]*title="当前管理员会话中不能停用自己的用户"[^>]*>.*停用<\/button>/);
  assert.match(markup, />重置 PIN<\/button>/);
});

test('PIN dialog static structure exposes modal semantics, labels, and password fields', () => {
  const markup = renderToStaticMarkup(
    <LocalUserPinDialog
      action={{ kind: 'promote', user: publisher }}
      pin=""
      pinConfirmation=""
      error=""
      isMutating={false}
      onPinChange={noop}
      onPinConfirmationChange={noop}
      onCancel={noop}
      onSubmit={noop}
    />
  );

  assert.match(markup, /role="dialog"/);
  assert.match(markup, /aria-modal="true"/);
  assert.match(markup, /aria-labelledby="local-user-pin-action-title"/);
  assert.match(markup, /aria-describedby="local-user-pin-action-description"/);
  assert.equal((markup.match(/type="password"/g) ?? []).length, 2);
  assert.match(markup, />取消<\/button>/);
  assert.match(markup, />确认保存<\/button>/);
});
