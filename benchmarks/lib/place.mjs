/**
 * Where a path leads. The config and the checkouts both ask it of paths that
 * may lead through links into the operator's own files.
 */

import { lstatSync, readlinkSync } from "fs";
import { dirname, join } from "path";

// How many links the way to one place may go through. The system gives up on a path at about as many.
const MAX_LINKS = 40;

/**
 * The place that an absolute path stands for once every link on the way is
 * followed as the system follows them: a ".." leaves the directory that a
 * link led to, not the one the link lies in. The end of the way may be
 * missing, since a write would put it there. Null when the place cannot be
 * told: the way goes in a circle, through something that is no directory or
 * cannot be looked into, or up from a directory that is not there.
 * Each directory that the way looks up a name in goes to `lookIn` as the
 * way gets there, also when the place cannot be told in the end.
 */
export function placeOf(path, lookIn = () => {}) {
  const parts = (text) => text.split("/").filter((part) => part !== "" && part !== ".");
  const pending = parts(path);
  let place = "/";
  // False once a part of the way is missing. Nothing beyond it is there to look at.
  let there = true;
  let links = 0;
  while (pending.length > 0) {
    const part = pending.shift();
    if (part === "..") {
      if (!there) return null;
      place = dirname(place);
      continue;
    }
    lookIn(place);
    const next = join(place, part);
    if (there) {
      let stats;
      try {
        stats = lstatSync(next, { throwIfNoEntry: false });
      } catch {
        return null;
      }
      if (stats?.isSymbolicLink()) {
        if (++links > MAX_LINKS) return null;
        const target = readlinkSync(next);
        pending.unshift(...parts(target));
        if (target.startsWith("/")) place = "/";
        continue;
      }
      there = stats !== undefined;
      // What follows would lead through something that is no directory, where the system goes no further
      if (there && !stats.isDirectory() && pending.length > 0) return null;
    }
    place = next;
  }
  return place;
}
