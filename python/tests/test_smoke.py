import coralshading


def test_import():
    assert coralshading.__version__.startswith("5.")
    assert coralshading.SHARED.is_dir()
