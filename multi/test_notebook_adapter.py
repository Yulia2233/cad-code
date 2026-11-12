import unittest
from notebook_adapter import adapt

class IdentityAdapterTests(unittest.TestCase):
    def test_preserve_geometry_and_unicode(self):
        source='import simplecadapi as scad\n# 圆柱\nbody=scad.make_cylinder_rsolid(radius=2, height=5)\nmodel = scad.Part(part_id="model", body=body)\n'
        result, changes=adapt(source)
        self.assertEqual(result,source.replace('part_id="model"','part_id=scad.notebook_id()'))
        self.assertEqual(len(changes),1)
        self.assertEqual(adapt(result),(result,[]))
    def test_unsupported_dynamic_identity_is_explicit(self):
        with self.assertRaisesRegex(ValueError,'Unsupported product ID'):
            adapt('model=scad.Part(part_id=variable, body=body)')
    def test_multiple_products_rejected(self):
        with self.assertRaisesRegex(ValueError,'Exactly one'):
            adapt('a=scad.Part(part_id="a",body=x)\nb=scad.Part(part_id="b",body=y)')

if __name__=='__main__':unittest.main()
