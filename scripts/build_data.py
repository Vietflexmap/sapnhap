from __future__ import annotations

import io
import json
import math
import sys
from pathlib import Path
from urllib.parse import quote

import pandas as pd
import requests

DATASET_MIRRORS = [
    "myleo198/sapnhap-bando-vn",
    "tmquan/sapnhap-bando-vn",
]

PROVINCE_ORDER = [
    "Hà Nội", "Cao Bằng", "Tuyên Quang", "Điện Biên", "Lai Châu", "Sơn La",
    "Lào Cai", "Thái Nguyên", "Lạng Sơn", "Quảng Ninh", "Bắc Ninh", "Phú Thọ",
    "Hải Phòng", "Hưng Yên", "Ninh Bình", "Thanh Hóa", "Nghệ An", "Hà Tĩnh",
    "Quảng Trị", "Huế", "Đà Nẵng", "Quảng Ngãi", "Gia Lai", "Khánh Hòa",
    "Đắk Lắk", "Lâm Đồng", "Đồng Nai", "Hồ Chí Minh", "Tây Ninh", "Đồng Tháp",
    "Vĩnh Long", "An Giang", "Cần Thơ", "Cà Mau",
]

EXPECTED = {
    "provinces": 34,
    "units": 3321,
    "phường": 697,
    "xã": 2611,
    "đặc khu": 13,
}


def clean(v):
    if v is None:
        return None
    try:
        if pd.isna(v):
            return None
    except Exception:
        pass
    if isinstance(v, float) and math.isnan(v):
        return None
    return v


def text(v, default=""):
    v = clean(v)
    return default if v is None else str(v).strip()


def number(v):
    v = clean(v)
    if v is None or v == "":
        return None
    try:
        return float(v)
    except Exception:
        return None


def integer(v):
    n = number(v)
    return None if n is None else int(round(n))


def short_province(name: str) -> str:
    s = text(name)
    for prefix in ("Thủ đô ", "Thành phố ", "Tỉnh "):
        if s.startswith(prefix):
            return s[len(prefix):].strip()
    return s


def unit_type(v: str) -> str:
    s = text(v).lower()
    if "phường" in s:
        return "phường"
    if "đặc khu" in s:
        return "đặc khu"
    if "xã" in s:
        return "xã"
    return s


def province_type(v: str) -> str:
    s = text(v).lower()
    if "thủ đô" in s:
        return "thành phố"
    if "thành phố" in s:
        return "thành phố"
    if "tỉnh" in s:
        return "tỉnh"
    return s


def download_parquet(filename: str) -> pd.DataFrame:
    errors = []
    for dataset in DATASET_MIRRORS:
        url = f"https://huggingface.co/datasets/{dataset}/resolve/main/data/{quote(filename)}?download=true"
        try:
            r = requests.get(url, timeout=120)
            r.raise_for_status()
            print(f"Downloaded {filename} from {dataset}: {len(r.content):,} bytes")
            return pd.read_parquet(io.BytesIO(r.content))
        except Exception as exc:
            errors.append(f"{dataset}: {exc}")
    raise RuntimeError(f"Could not download {filename}: {' | '.join(errors)}")


def build() -> dict:
    provinces_df = download_parquet("provinces.parquet")
    communes_df = download_parquet("communes.parquet")

    order_by_name = {name: i + 1 for i, name in enumerate(PROVINCE_ORDER)}

    province_rows = {}
    for _, row in provinces_df.iterrows():
        short = short_province(row.get("ten_short") or row.get("ten"))
        if short not in order_by_name:
            # ten_short is normally preferred; fall back to full label stripping.
            short = short_province(row.get("ten"))
        if short not in order_by_name:
            raise ValueError(f"Unknown province in source: {row.get('ten')!r} / {row.get('ten_short')!r}")
        province_rows[short] = row

    units = []
    counts = {name: {"phường": 0, "xã": 0, "đặc khu": 0, "khác": 0} for name in PROVINCE_ORDER}

    for idx, row in communes_df.iterrows():
        parent = short_province(row.get("parent_ten"))
        if parent not in order_by_name:
            raise ValueError(f"Unknown parent province for commune {row.get('ten')!r}: {row.get('parent_ten')!r}")
        typ = unit_type(row.get("type"))
        counts[parent][typ if typ in counts[parent] else "khác"] += 1
        code = text(row.get("ma")).zfill(5)
        area = number(row.get("area_km2"))
        pop = integer(row.get("population"))
        density = number(row.get("density"))
        if density is None and area and pop is not None:
            density = pop / area
        full_name = text(row.get("ten"))
        name = text(row.get("ten_short")) or full_name.removeprefix("Phường ").removeprefix("Xã ").removeprefix("Đặc khu ")
        units.append({
            "id": f"u:{code}",
            "province_order": order_by_name[parent],
            "province_name": parent,
            "province_full_name": text(province_rows[parent].get("ten")),
            "order": idx + 1,
            "code": code,
            "name": name,
            "full_name": full_name,
            "type": typ,
            "area_km2": area,
            "population_2025": pop,
            "density": density,
            "merged_from": text(row.get("predecessors")) or None,
            "administrative_center": text(row.get("capital")) or text(row.get("address")) or None,
            "resolution": text(row.get("decree")) or None,
            "centroid_lon": number(row.get("centroid_lon")),
            "centroid_lat": number(row.get("centroid_lat")),
            "bbox": clean(row.get("bbox")),
        })

    units.sort(key=lambda u: (u["province_order"], u["type"], u["name"]))

    provinces = []
    for order, short in enumerate(PROVINCE_ORDER, 1):
        row = province_rows.get(short)
        if row is None:
            raise ValueError(f"Missing province: {short}")
        area = number(row.get("area_km2"))
        pop = integer(row.get("population"))
        density = number(row.get("density"))
        if density is None and area and pop is not None:
            density = pop / area
        province_units = [u for u in units if u["province_order"] == order]
        provinces.append({
            "id": f"p:{order:02d}",
            "order": order,
            "code": text(row.get("ma")),
            "name": short,
            "full_name": text(row.get("ten")),
            "type": province_type(row.get("type")),
            "merge_origin": text(row.get("predecessors")) or None,
            "administrative_center": text(row.get("address")) or text(row.get("capital")) or None,
            "resolution": text(row.get("decree")) or None,
            "area_km2": area,
            "population_2025": pop,
            "density": density,
            "commune_level_count": len(province_units),
            "counts_by_type": counts[short],
            "centroid_lon": number(row.get("centroid_lon")),
            "centroid_lat": number(row.get("centroid_lat")),
            "bbox": clean(row.get("bbox")),
        })

    type_counts = {
        "phường": sum(1 for u in units if u["type"] == "phường"),
        "xã": sum(1 for u in units if u["type"] == "xã"),
        "đặc khu": sum(1 for u in units if u["type"] == "đặc khu"),
    }
    actual = {"provinces": len(provinces), "units": len(units), **type_counts}
    if actual != EXPECTED:
        raise ValueError(f"Dataset validation failed. Expected {EXPECTED}, got {actual}")
    if len({u["code"] for u in units}) != EXPECTED["units"]:
        raise ValueError("Commune codes are not unique")

    return {
        "metadata": {
            "schema": "vietflex-admin-webgis-v1",
            "snapshot": "2026-09",
            "source": "sapnhap.bando.com.vn via Hugging Face mirror",
            "validation": actual,
        },
        "provinces": provinces,
        "units": units,
    }


def main():
    payload = build()
    out = Path("data/admin.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    meta = {
        "bytes": out.stat().st_size,
        "validation": payload["metadata"]["validation"],
        "source": payload["metadata"]["source"],
    }
    Path("data/source-meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(meta, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise
