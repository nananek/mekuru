#!/usr/bin/env python3
"""
Mekuru Debug API CLI Tool for LLM & Developers
Allows live inspection of input strokes and rendered canvas images.

Usage:
  python3 scripts/debug_api.py status
  python3 scripts/debug_api.py latest [--out <path>]
  python3 scripts/debug_api.py preset <name> [--out <path>]
  python3 scripts/debug_api.py render <input.json> [--out <path>]
  python3 scripts/debug_api.py list [--limit <N>]
  python3 scripts/debug_api.py clear
"""

import sys
import os
import json
import argparse
import urllib.request
import urllib.error

DEFAULT_BASE_URL = os.environ.get("MEKURU_URL", "http://localhost:3000")
DEFAULT_OUT_DIR = os.environ.get("MEKURU_OUT_DIR", "/work/debug_output")


def get_json(url: str):
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def post_json(url: str, data: dict):
    body = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=12) as resp:
        return json.loads(resp.read().decode("utf-8"))


def download_file(url: str, out_path: str):
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    urllib.request.urlretrieve(url, out_path)
    return out_path


def post_render_image(url: str, payload: dict, out_path: str):
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{url}?format=image",
        data=body,
        headers={"Content-Type": "application/json", "Accept": "image/png"},
    )
    with urllib.request.urlopen(req, timeout=12) as resp:
        content = resp.read()
        with open(out_path, "wb") as f:
            f.write(content)
    return out_path


def cmd_status(base_url: str):
    url = f"{base_url}/api/debug/status"
    try:
        data = get_json(url)
        print("=== Mekuru Debug API Status ===")
        print(f"Backend Server:      Online ({base_url})")
        print(f"Live Bridge Active:  {'YES (Browser ready for live rendering)' if data.get('bridge_connected') else 'NO (Open http://localhost:3000/debug.html)'}")
        print(f"Render Queue:        {data.get('queue_length', 0)} jobs")
        print(f"Saved Strokes:       {'Present' if data.get('has_saved_strokes') else 'Empty'}")
        return 0
    except Exception as e:
        print(f"Error connecting to debug API at {base_url}: {e}", file=sys.stderr)
        return 1


def cmd_latest(base_url: str, out_img: str | None):
    url = f"{base_url}/api/debug/strokes/latest"
    try:
        data = get_json(url)
        stroke_id = data.get("id")
        points = data.get("points", [])
        point_count = len(points)
        min_alt = 1.57
        avg_press = 0.0
        if points:
            press_sum = sum(p.get("pressure", 0) for p in points)
            avg_press = press_sum / point_count
            min_alt = min(p.get("altitudeAngle", 1.57) for p in points)

        is_shading = min_alt < 0.45
        mode = "Tilt Shading" if is_shading else "Normal Line"

        print("=== Latest Stroke Captured from iPad / Browser ===")
        print(f"Stroke ID:        {stroke_id}")
        print(f"Label:            {data.get('label')}")
        print(f"Timestamp:        {data.get('created_at')}")
        print(f"Points Count:     {point_count} points")
        print(f"Mode:             {mode}")
        print(f"Min Altitude:     {min_alt:.3f} rad ({min_alt * 180 / 3.14159:.1f}°)")
        print(f"Avg Pressure:     {avg_press:.3f}")

        if data.get("has_image"):
            if not out_img:
                out_img = os.path.join(DEFAULT_OUT_DIR, f"latest_{stroke_id}.png")
            img_url = f"{base_url}/api/debug/strokes/{stroke_id}/image"
            download_file(img_url, out_img)
            print(f"Rendered Image:   {out_img}")
            print(f"-> View image with: view_file AbsolutePath='{out_img}'")
        else:
            print("Rendered Image:   None (stroke recorded without canvas image)")

        # Save points JSON alongside image
        json_path = (out_img.rsplit(".", 1)[0] if out_img else os.path.join(DEFAULT_OUT_DIR, f"latest_{stroke_id}")) + ".json"
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(points, f, indent=2)
        print(f"Points Data JSON: {json_path}")
        return 0
    except Exception as e:
        print(f"Error fetching latest stroke: {e}", file=sys.stderr)
        return 1


def cmd_presets(base_url: str):
    url = f"{base_url}/api/debug/presets"
    try:
        presets = get_json(url)
        print("=== Available Test Presets ===")
        for key, p in presets.items():
            pts = p.get("points", [])
            print(f"- {key}:")
            print(f"    Name: {p.get('name')}")
            print(f"    Points: {len(pts)} pts")
            print(f"    Description: {p.get('description')}")
        return 0
    except Exception as e:
        print(f"Error fetching presets: {e}", file=sys.stderr)
        return 1


def cmd_preset_render(base_url: str, preset_name: str, out_img: str | None):
    presets_url = f"{base_url}/api/debug/presets"
    try:
        presets = get_json(presets_url)
        if preset_name not in presets:
            print(f"Error: Unknown preset '{preset_name}'. Run 'presets' command to list.", file=sys.stderr)
            return 1

        preset = presets[preset_name]
        points = preset.get("points", [])

        if not out_img:
            out_img = os.path.join(DEFAULT_OUT_DIR, f"{preset_name}.png")

        render_url = f"{base_url}/api/debug/render"
        print(f"Sending preset '{preset_name}' ({len(points)} points) to live render bridge...")
        post_render_image(
            render_url,
            {
                "label": preset_name,
                "points": points,
                "width": 800,
                "height": 600,
                "dpr": 2.0,
            },
            out_img,
        )
        print(f"Successfully rendered: {out_img}")
        print(f"-> View image with: view_file AbsolutePath='{out_img}'")
        return 0
    except urllib.error.HTTPError as e:
        if e.code == 503:
            print("Bridge Warning: No browser connected to live render bridge.", file=sys.stderr)
            print("Please open http://localhost:3000/debug.html in a browser first.", file=sys.stderr)
        else:
            print(f"HTTP Error {e.code}: {e.read().decode('utf-8')}", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"Error rendering preset: {e}", file=sys.stderr)
        return 1


def cmd_render_json(base_url: str, json_file: str, out_img: str | None):
    try:
        with open(json_file, "r", encoding="utf-8") as f:
            points = json.load(f)

        if not isinstance(points, list):
            print(f"Error: {json_file} must contain a JSON array of points.", file=sys.stderr)
            return 1

        if not out_img:
            base_name = os.path.splitext(os.path.basename(json_file))[0]
            out_img = os.path.join(DEFAULT_OUT_DIR, f"{base_name}_rendered.png")

        render_url = f"{base_url}/api/debug/render"
        print(f"Rendering {len(points)} points from {json_file}...")
        post_render_image(
            render_url,
            {
                "label": f"render_{os.path.basename(json_file)}",
                "points": points,
                "width": 800,
                "height": 600,
                "dpr": 2.0,
            },
            out_img,
        )
        print(f"Successfully rendered: {out_img}")
        print(f"-> View image with: view_file AbsolutePath='{out_img}'")
        return 0
    except Exception as e:
        print(f"Error rendering stroke: {e}", file=sys.stderr)
        return 1


def cmd_list(base_url: str, limit: int):
    url = f"{base_url}/api/debug/strokes?limit={limit}"
    try:
        data = get_json(url)
        strokes = data.get("strokes", [])
        print(f"=== Recent Debug Strokes ({len(strokes)} found) ===")
        for s in strokes:
            has_img = " [IMAGE]" if s.get("has_image") else ""
            print(f"[{s.get('created_at', '')[11:19]}] {s.get('id')}: {s.get('label') or 'untitled'} ({s.get('point_count')} pts){has_img}")
        return 0
    except Exception as e:
        print(f"Error listing strokes: {e}", file=sys.stderr)
        return 1


def cmd_clear(base_url: str):
    url = f"{base_url}/api/debug/strokes"
    try:
        req = urllib.request.Request(url, method="DELETE")
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            print(f"Cleared {data.get('deleted_count', 0)} debug strokes from DB.")
        return 0
    except Exception as e:
        print(f"Error clearing strokes: {e}", file=sys.stderr)
        return 1


def main():
    parser = argparse.ArgumentParser(description="Mekuru Debug API Tool for LLM & Developers")
    parser.add_argument("--url", default=DEFAULT_BASE_URL, help="Base URL of Mekuru server (default: http://localhost:3000)")

    subparsers = parser.add_subparsers(dest="command")

    subparsers.add_parser("status", help="Check server and live bridge status")

    p_latest = subparsers.add_parser("latest", help="Fetch latest stroke captured from iPad/browser")
    p_latest.add_argument("--out", "-o", help="Output PNG image path")

    subparsers.add_parser("presets", help="List available test presets")

    p_preset = subparsers.add_parser("preset", help="Render a test preset via live bridge")
    p_preset.add_argument("name", help="Preset name (e.g. tilt_flat_shading, pressure_ramp_line)")
    p_preset.add_argument("--out", "-o", help="Output PNG image path")

    p_render = subparsers.add_parser("render", help="Render a stroke JSON file via live bridge")
    p_render.add_argument("file", help="Path to JSON file containing array of Point objects")
    p_render.add_argument("--out", "-o", help="Output PNG image path")

    p_list = subparsers.add_parser("list", help="List recent recorded strokes")
    p_list.add_argument("--limit", type=int, default=20, help="Max strokes to return")

    subparsers.add_parser("clear", help="Clear all recorded debug strokes")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return 0

    if args.command == "status":
        return cmd_status(args.url)
    elif args.command == "latest":
        return cmd_latest(args.url, args.out)
    elif args.command == "presets":
        return cmd_presets(args.url)
    elif args.command == "preset":
        return cmd_preset_render(args.url, args.name, args.out)
    elif args.command == "render":
        return cmd_render_json(args.url, args.file, args.out)
    elif args.command == "list":
        return cmd_list(args.url, args.limit)
    elif args.command == "clear":
        return cmd_clear(args.url)

    return 0


if __name__ == "__main__":
    sys.exit(main())
