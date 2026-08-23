import assert from 'node:assert/strict';
import test from 'node:test';
import { getBrowserCandidates } from './session.ts';

test('getBrowserCandidates includes Helium on every supported platform', () => {
  assert.deepEqual(
    getBrowserCandidates('/Users/me', 'darwin').find(candidate => candidate.name === 'Helium'),
    {
      name: 'Helium',
      profileDir: '/Users/me/Library/Application Support/net.imput.helium',
    },
  );
  assert.deepEqual(
    getBrowserCandidates('/home/me', 'linux').find(candidate => candidate.name === 'Helium'),
    {
      name: 'Helium',
      profileDir: '/home/me/.config/net.imput.helium',
    },
  );
  assert.deepEqual(
    getBrowserCandidates('C:\\Users\\me', 'win32', 'C:\\Users\\me\\AppData\\Local').find(
      candidate => candidate.name === 'Helium',
    ),
    {
      name: 'Helium',
      profileDir: 'C:\\Users\\me\\AppData\\Local\\imput\\Helium\\User Data',
    },
  );
});
