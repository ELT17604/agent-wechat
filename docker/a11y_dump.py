#!/usr/bin/env python3
import argparse
import json
import re
import sys

try:
    import gi
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi
except Exception as exc:
    print(json.dumps({"error": f"failed to import atspi: {exc}"}))
    sys.exit(1)


def find_wechat_app():
    Atspi.init()
    desktop = Atspi.get_desktop(0)
    for i in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(i)
        if app and app.get_name() == 'wechat':
            return app
    return None


def find_element(node, role_name=None, name=None, depth=0, max_depth=20):
    if depth > max_depth or not node:
        return None
    try:
        if role_name and node.get_role_name() != role_name:
            pass
        else:
            if name is None or node.get_name() == name:
                return node
        for i in range(node.get_child_count()):
            child = node.get_child_at_index(i)
            result = find_element(child, role_name, name, depth + 1, max_depth)
            if result:
                return result
    except Exception:
        return None
    return None


def parse_chat(raw):
    result = {
        'name': '',
        'unread': 0,
        'sender': None,
        'preview': None,
        'time': None,
        'pinned': False,
        'muted': False,
        'raw': raw
    }

    text = raw.strip()

    if re.search(r'Mute Notif', text):
        result['muted'] = True
        text = re.sub(r'\s*Mute Notif\w*\s*$', '', text)

    time_match = re.search(r'\s(\d{1,2}:\d{2})\s*$', text)
    if time_match:
        result['time'] = time_match.group(1)
        text = text[:time_match.start()].strip()

    if 'Stuck on Top' in text:
        result['pinned'] = True
        text = text.replace('Stuck on Top', '').strip()

    unread_match = re.search(r'^(.+?)\s+(\d+)\s+unread message\(s\)\s*(.*)$', text)
    if unread_match:
        result['name'] = unread_match.group(1).strip()
        result['unread'] = int(unread_match.group(2))
        remainder = unread_match.group(3).strip()
        remainder = re.sub(r'^\[\d+\]\s*', '', remainder)
        sender_match = re.match(r'^([^:]+):\s*(.+)$', remainder)
        if sender_match:
            result['sender'] = sender_match.group(1).strip()
            result['preview'] = sender_match.group(2).strip()
        elif remainder:
            result['preview'] = remainder
    else:
        colon_match = re.search(r'^(.+?)\s+([^:\s]+):\s*(.+)$', text)
        if colon_match:
            result['name'] = colon_match.group(1).strip()
            result['sender'] = colon_match.group(2).strip()
            result['preview'] = colon_match.group(3).strip()
        else:
            result['name'] = text.strip()

    return result


def get_bounds(node):
    try:
        comp = node.get_component_iface()
        if not comp:
            return None
        rect = comp.get_extents(Atspi.CoordType.SCREEN)
        return {
            "x": rect.x,
            "y": rect.y,
            "width": rect.width,
            "height": rect.height
        }
    except Exception:
        return None


def dump_chats(app):
    chat_list = find_element(app, 'list', 'Chats')
    if not chat_list:
        return {"error": "chat list not found", "items": []}

    items = []
    for i in range(chat_list.get_child_count()):
        item = chat_list.get_child_at_index(i)
        if not item:
            continue
        raw = item.get_name() or ""
        parsed = parse_chat(raw)
        parsed['index'] = i
        parsed['bounds'] = get_bounds(item)
        items.append(parsed)
    return {"items": items}


def dump_messages(app):
    messages = find_element(app, 'list', 'Messages')
    if not messages:
        return {"error": "messages list not found", "items": []}
    items = []
    for i in range(messages.get_child_count()):
        item = messages.get_child_at_index(i)
        if not item:
            continue
        raw = item.get_name() or ""
        kind = "timestamp" if re.match(r'^\d{1,2}:\d{2}$', raw.strip()) else "message"
        items.append({
            "index": i,
            "text": raw,
            "kind": kind,
            "bounds": get_bounds(item)
        })
    return {"items": items}


def dump_buttons(app):
    buttons = []

    def walk(node, depth=0, max_depth=20):
        if depth > max_depth or not node:
            return
        try:
            role = node.get_role_name()
            name = node.get_name() or ""
            if role == 'push button' and name:
                buttons.append({
                    "name": name,
                    "bounds": get_bounds(node)
                })
            for i in range(node.get_child_count()):
                walk(node.get_child_at_index(i), depth + 1, max_depth)
        except Exception:
            return

    walk(app)
    return {"items": buttons}


def dump_tree(app):
    nodes = []

    def walk(node, depth=0, max_depth=8):
        if depth > max_depth or not node:
            return
        try:
            nodes.append({
                "depth": depth,
                "role": node.get_role_name(),
                "name": node.get_name() or "",
                "bounds": get_bounds(node)
            })
            for i in range(node.get_child_count()):
                walk(node.get_child_at_index(i), depth + 1, max_depth)
        except Exception:
            return

    walk(app)
    return {"items": nodes}


def has_valid_bounds(bounds):
    """Check if bounds are valid (non-zero size)."""
    if not bounds:
        return False
    return bounds.get("width", 0) > 0 and bounds.get("height", 0) > 0


def dump_desktop():
    """Dump the full desktop accessibility tree (all windows).

    Only includes elements with valid (non-zero) bounds, since elements
    with zero bounds are not visible/clickable.
    """
    Atspi.init()
    desktop = Atspi.get_desktop(0)
    nodes = []

    def walk(node, depth=0, max_depth=10):
        if depth > max_depth or not node:
            return
        try:
            name = node.get_name() or ""
            role = node.get_role_name()
            bounds = get_bounds(node)

            # Only include elements with valid bounds (visible/clickable)
            # Always include top-level (depth <= 1) for structure
            if depth <= 1 or has_valid_bounds(bounds):
                # Skip empty labels inside buttons (duplicates)
                if role == "label" and not name:
                    pass
                else:
                    nodes.append({
                        "depth": depth,
                        "role": role,
                        "name": name,
                        "bounds": bounds
                    })

            for i in range(node.get_child_count()):
                walk(node.get_child_at_index(i), depth + 1, max_depth)
        except Exception:
            return

    walk(desktop)
    return {"items": nodes}


def probe(app):
    chat_list = find_element(app, 'list', 'Chats')
    messages = find_element(app, 'list', 'Messages')
    return {
        "loggedIn": chat_list is not None,
        "hasChats": chat_list is not None,
        "hasMessages": messages is not None
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--scope", choices=["chats", "messages", "buttons", "full", "desktop"], default="chats")
    parser.add_argument("--format", choices=["json"], default="json")
    parser.add_argument("--probe", action="store_true")
    args = parser.parse_args()

    # Desktop scope doesn't require wechat app
    if args.scope == "desktop":
        print(json.dumps(dump_desktop()))
        return

    app = find_wechat_app()
    if not app:
        print(json.dumps({"error": "wechat app not found", "loggedIn": False}))
        sys.exit(1)

    if args.probe:
        print(json.dumps(probe(app)))
        return

    if args.scope == "chats":
        print(json.dumps(dump_chats(app)))
        return

    if args.scope == "messages":
        print(json.dumps(dump_messages(app)))
        return

    if args.scope == "buttons":
        print(json.dumps(dump_buttons(app)))
        return

    print(json.dumps(dump_tree(app)))


if __name__ == "__main__":
    main()
