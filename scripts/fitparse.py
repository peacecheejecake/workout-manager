import argparse
from pathlib import Path

import pandas as pd
from fitparse import FitFile


def messages_to_df(fitfile, message_type):
    rows = []

    for message in fitfile.get_messages(message_type):
        rows.append({
            field.name: field.value
            for field in message
        })

    return pd.DataFrame(rows)


parser = argparse.ArgumentParser()
parser.add_argument("filename", type=Path)
args = parser.parse_args()

fitfile = FitFile(args.filename)

for message_type in ["record", "lap", "session"]:
    df = messages_to_df(fitfile, message_type)

    output = args.filename.with_name(
        f"{args.filename.stem}_{message_type}.parquet"
    )

    df.to_csv(output, index=False)

    print(f"{message_type}: {len(df)} rows -> {output}")
