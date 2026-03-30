# -*- mode: python ; coding: utf-8 -*-

import sys
import os
from PyInstaller.utils.hooks import collect_data_files

# Collect static and template files
datas = [
    (os.path.join('frontend', 'templates'), 'templates'),
    (os.path.join('frontend', 'static'), 'static'),
]

a = Analysis(
    ['backend\\run.py'],
    pathex=[],
    binaries=[],
    datas=datas,  # use the variable
    hiddenimports=[
        "engineio.async_drivers.threading",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='run',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
)