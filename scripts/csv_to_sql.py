#!/usr/bin/env python3
"""
Convert NEW STORE REGISTER csv (SAP export) into a D1-ready seed_data.sql
Usage: python3 csv_to_sql.py input.csv seed_data.sql
"""
import csv
import sys
import re


def esc(v):
    if v is None:
        return "NULL"
    v = str(v).strip()
    if v == "" or v.upper() in ("0", "#N/A") and False:
        pass
    if v == "":
        return "NULL"
    return "'" + v.replace("'", "''") + "'"


def esc_text_allow_zero(v):
    v = (v or "").strip()
    if v == "":
        return "NULL"
    return "'" + v.replace("'", "''") + "'"


def num(v, default="0"):
    v = (v or "").strip().replace(",", "")
    if v == "":
        return default
    try:
        float(v)
        return v
    except ValueError:
        return default


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else "input.csv"
    dst = sys.argv[2] if len(sys.argv) > 2 else "seed_data.sql"

    seen = set()
    rows_out = []

    with open(src, encoding="utf-8", errors="replace") as f:
        reader = csv.reader(f)
        next(reader)  # header
        for row in reader:
            row = row + [""] * (24 - len(row))
            sap_code = row[2].strip()
            desc = row[3].strip()
            if not sap_code or not desc:
                continue
            if sap_code in seen:
                continue  # skip duplicate SAP codes
            seen.add(sap_code)

            uom = row[1].strip()
            net_price = num(row[4])
            specs = row[5].strip()
            rol = num(row[6], "0")
            roq = num(row[7], "0")
            cur_stock = num(row[8], "0")
            order_qty = num(row[9], "0")
            critical = row[10].strip()
            process_details = row[11].strip()
            vendor_code = row[12].strip()
            vendor_name = row[13].strip()
            vendor_email = row[14].strip()
            vendor_phone = row[15].strip()
            function_area = row[16].strip()
            location = row[17].strip()
            machine = row[18].strip()
            sub_eq = row[19].strip()
            orig_name = row[20].strip()
            fpr = row[21].strip()
            set_by = row[22].strip()
            remarks = row[23].strip()

            vals = [
                esc(sap_code), esc(uom), esc(desc), net_price, esc(specs),
                rol, roq, cur_stock, order_qty, esc(critical), esc(process_details),
                esc(vendor_code), esc(vendor_name), esc(vendor_email), esc(vendor_phone),
                esc(function_area), esc(location), esc(machine), esc(sub_eq),
                esc(orig_name), esc(fpr), esc(set_by), esc(remarks)
            ]
            rows_out.append(vals)

    cols = ("sap_code, uom, description, net_price, specs_make, rol, roq, "
            "current_stock, order_qty_pending, critical_category, process_details, "
            "vendor_code, vendor_name, vendor_email, vendor_phone, function_area, "
            "location, machine_equipment, sub_equipment, original_part_name, "
            "fpr_name, set_by, remarks")

    with open(dst, "w", encoding="utf-8") as out:
        out.write("-- Auto-generated seed data from store register CSV\n")
        out.write("-- Total unique items: {}\n\n".format(len(rows_out)))
        batch = 200
        for i in range(0, len(rows_out), batch):
            chunk = rows_out[i:i + batch]
            out.write(f"INSERT INTO items ({cols}) VALUES\n")
            lines = []
            for v in chunk:
                lines.append("(" + ",".join(str(x) for x in v) + ")")
            out.write(",\n".join(lines))
            out.write(";\n\n")

    print(f"Wrote {len(rows_out)} unique items to {dst}")


if __name__ == "__main__":
    main()
