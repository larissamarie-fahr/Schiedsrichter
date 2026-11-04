import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta

NS = {
    "m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}
EXCEL_EPOCH = datetime(1899, 12, 30)


def column_name(reference):
    match = re.match(r"[A-Z]+", reference or "")
    return match.group(0) if match else ""


def workbook_parts(archive):
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    targets = {item.attrib["Id"]: item.attrib["Target"] for item in relationships}
    shared_strings = []
    if "xl/sharedStrings.xml" in archive.namelist():
        root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
        shared_strings = [
            "".join(text.text or "" for text in item.findall(".//m:t", NS))
            for item in root.findall("m:si", NS)
        ]
    sheets = []
    for sheet in workbook.findall("m:sheets/m:sheet", NS):
        target = targets[sheet.attrib["{" + NS["r"] + "}id"]].lstrip("/")
        if not target.startswith("xl/"):
            target = "xl/" + target
        sheets.append((sheet.attrib["name"], target))
    return sheets, shared_strings


def cell_value(cell, shared_strings):
    value = cell.find("m:v", NS)
    raw = value.text if value is not None else ""
    if cell.attrib.get("t") == "s" and raw:
        return shared_strings[int(raw)]
    if cell.attrib.get("t") == "inlineStr":
        return "".join(text.text or "" for text in cell.findall(".//m:t", NS))
    return raw


def sheet_rows(archive, target, shared_strings):
    with archive.open(target) as source:
        for _, row in ET.iterparse(source, events=("end",)):
            if row.tag.endswith("}row"):
                values = {}
                for cell in row.findall("m:c", NS):
                    values[column_name(cell.attrib.get("r"))] = cell_value(cell, shared_strings)
                yield values
                row.clear()


def excel_date(value):
    if not value:
        return None
    try:
        date = EXCEL_EPOCH + timedelta(days=float(value))
        return date.strftime("%Y-%m-%d")
    except (ValueError, OverflowError):
        for format_string in ("%d.%m.%Y", "%Y-%m-%d"):
            try:
                return datetime.strptime(value, format_string).strftime("%Y-%m-%d")
            except ValueError:
                pass
    return None


def amount(value):
    try:
        return round(float(str(value).replace(",", ".")), 2)
    except (ValueError, TypeError):
        return None


def game_season(game_date):
    year, month = map(int, game_date.split("-")[:2])
    start = year if month >= 7 else year - 1
    return f"{start}/{(start + 1) % 100:02d}"


def classify_salary_game(value, fee):
    raw = (value or "Nicht angegeben").strip()
    age = raw
    system = "Nicht angegeben"
    role = ""
    league = ""
    round_stage = ""

    if re.search(r"\bLR4\s*$", raw, re.IGNORECASE):
        age = re.sub(r"\s*[-–]?\s*LR4\s*$", "", raw, flags=re.IGNORECASE).strip()
        system, role = "4-Mann", "Linienrichter"
    elif re.search(r"[-–]\s*LR\s*$", raw, re.IGNORECASE):
        age = re.sub(r"\s*[-–]\s*LR\s*$", "", raw, flags=re.IGNORECASE).strip()
        role = "Linienrichter"
    else:
        for number in (2, 3, 4):
            match = re.search(rf"\s*[-–]\s*{number}\s*[- ]?Mann\s*$", raw, re.IGNORECASE)
            if match:
                age = raw[:match.start()].strip()
                system = f"{number}-Mann"
                break

    normalized = re.sub(r"\s+", " ", age).strip()
    normalized = re.sub(r"^U17\s*[-–]\s*DEB$", "U17 DEB", normalized, flags=re.IGNORECASE)
    normalized = re.sub(r"^DEB\s*[-–]\s*U15$", "U15 DEB", normalized, flags=re.IGNORECASE)
    normalized = re.sub(r"^DEB\s*[-–]\s*U16$", "U16 DEB", normalized, flags=re.IGNORECASE)

    if normalized.upper() == "BYL":
        if role == "Linienrichter":
            system = "4-Mann"
            if fee == 200:
                round_stage = "PlayOff/-Down"
        elif fee in (220, 250):
            system, role = "4-Mann", "Hauptschiedsrichter"
            if fee == 250:
                round_stage = "PlayOff/-Down"
    elif normalized.upper() == "U20":
        if role == "Linienrichter":
            system, league = "3-Mann", "BYL"
        elif fee == 100 and not system.startswith(("3-", "4-")):
            system = "2-Mann"
    elif normalized.upper() == "LL":
        if role == "Linienrichter" and fee == 120:
            system = "3-Mann"
        elif role == "Linienrichter" and fee == 100:
            system = "4-Mann"
        elif fee == 150:
            system = "2-Mann"
    elif normalized.upper() == "BZL" and fee == 120:
        system = "2-Mann"
    elif normalized.upper() == "U11" and fee == 70:
        system = "1-Mann"
    elif normalized.upper() == "U13" and fee == 70:
        system = "2-Mann"
    elif normalized.upper() == "U15" and fee == 80:
        system = "2-Mann"
    elif normalized.upper() == "U17" and fee == 95:
        system = "2-Mann"
    elif normalized.upper() in ("U17 DEB", "U15 DEB"):
        normalized = "U17 DEB" if normalized.upper() == "U17 DEB" else "U15 DEB"
        system = "2-Mann"
    elif normalized.upper() == "FRAUEN" and fee == 100:
        system = "2-Mann"

    return {
        "age_group": normalized or "Nicht angegeben",
        "system": system,
        "league": league,
        "role": role,
        "round_stage": round_stage,
    }


def classify_assignment(value, slot_count, self_slot):
    raw = re.sub(r"\s+", " ", (value or "Nicht angegeben").strip())
    upper = raw.upper()
    age_group = raw
    league = ""
    round_stage = ""

    if upper.startswith("F-BYL") or upper.startswith("F BYL"):
        age_group, league = "Frauen", "BYL"
    elif upper.startswith("BYL"):
        age_group = "BYL"
        if re.search(r"(?:^|[- ])(?:V|VR|VORRUNDE)$", upper):
            round_stage = "Vorrunde"
        elif re.search(r"(?:^|[- ])(?:D|AR|ABSTIEGSRUNDE)$", upper):
            round_stage = "Abstiegsrunde"
        elif "PO" in upper or "PLAYOFF" in upper or "PLAYDOWN" in upper:
            round_stage = "PlayOff/-Down"
    elif upper.startswith("BZL"):
        age_group = "BZL"
    elif upper.startswith("LL"):
        age_group = "LL"
    elif upper.startswith("U17") and "DEB" in upper:
        age_group = "U17 DEB"
    else:
        match = re.match(r"^(U11|U13|U15|U17|U20|FRAUEN)\b", upper)
        if match:
            age_group = "Frauen" if match.group(1) == "FRAUEN" else match.group(1)

    system = f"{slot_count}-Mann" if 1 <= slot_count <= 4 else "Nicht angegeben"
    role = ""
    if slot_count >= 3 and self_slot is not None:
        role = "Hauptschiedsrichter" if self_slot < 2 else "Linienrichter"
    return {"age_group": age_group, "league": league, "system": system, "role": role, "round_stage": round_stage}


def read_salary_workbook(path):
    games = []
    expenses = []
    with zipfile.ZipFile(path) as archive:
        sheets, shared_strings = workbook_parts(archive)
        for sheet_name, target in sheets:
            for row in sheet_rows(archive, target, shared_strings):
                date = excel_date(row.get("B"))
                home = (row.get("C") or "").strip()
                away = (row.get("D") or "").strip()
                fee = amount(row.get("F"))
                if date and home and fee is not None:
                    classification = classify_salary_game(row.get("E"), fee)
                    if not away:
                        away = f"Sammelabrechnung {row.get('A', '').strip()}"
                        classification = {"age_group": "Nicht angegeben", "system": "Sammelabrechnung", "league": "", "role": "", "round_stage": ""}
                    games.append({
                        "game_date": date,
                        "game_time": "00:00",
                        **classification,
                        "home_team": home,
                        "away_team": away,
                        "stadium": "",
                        "stadium_address": "",
                        "fee": fee,
                        "route_km": amount(row.get("G")),
                        "route_mode": "manual",
                        "season": game_season(date),
                        "fee_manual": True,
                        "source": "salary",
                    })
                expense_date = excel_date(row.get("K"))
                expense_amount = amount(row.get("L"))
                category = (row.get("M") or "").strip()
                description = (row.get("N") or "").strip()
                if expense_date and expense_amount is not None and (category or description):
                    expenses.append({
                        "expense_date": expense_date,
                        "category": category or "Sonstiges",
                        "description": description or category or "Importierte Ausgabe",
                        "amount": expense_amount,
                    })
    return games, expenses


def read_assignments(path):
    games = []
    with zipfile.ZipFile(path) as archive:
        sheets, shared_strings = workbook_parts(archive)
        for _, target in sheets:
            for row in sheet_rows(archive, target, shared_strings):
                date = excel_date(row.get("B")) if re.match(r"^\d{1,2}\.\d{1,2}\.\d{4}$", row.get("B", "")) else None
                home = (row.get("E") or "").strip()
                away = (row.get("F") or "").strip()
                slot_columns = ("H", "I", "J", "K")
                referee_slots = [row.get(column, "").strip() for column in slot_columns]
                self_slot = next((index for index, name in enumerate(referee_slots) if name.casefold() == "du"), None)
                assigned_count = sum(bool(name) and name not in ("–", "-") for name in referee_slots)
                if not date or not home or not away or self_slot is None:
                    continue
                classification = classify_assignment(row.get("D"), assigned_count, self_slot)
                games.append({
                    "game_date": date,
                    "game_time": (row.get("C") or "00:00").strip(),
                    **classification,
                    "home_team": home,
                    "away_team": away,
                    "stadium": (row.get("G") or "").strip(),
                    "stadium_address": (row.get("G") or "").strip(),
                    "fee": 0,
                    "route_km": None,
                    "route_mode": "manual",
                    "season": game_season(date),
                    "fee_manual": None,
                    "source": "assignment",
                })
    return games


def main():
    if len(sys.argv) != 3:
        raise SystemExit("Nutzung: import_xlsx.py EINTEILUNGEN.xlsx GEHALT.xlsx")
    assignment_games = read_assignments(sys.argv[1])
    salary_games, expenses = read_salary_workbook(sys.argv[2])
    print(json.dumps({
        "games": salary_games + assignment_games,
        "expenses": expenses,
        "counts": {
            "salaryGames": len(salary_games),
            "assignmentGames": len(assignment_games),
            "expenses": len(expenses),
        },
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
